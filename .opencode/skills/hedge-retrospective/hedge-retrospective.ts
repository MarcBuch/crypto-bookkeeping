#!/usr/bin/env bun
/**
 * hedge-retrospective.ts — Was a delta hedge worth it over a past period?
 *
 * Given an LP position and a lookback window (days), computes:
 *   1. What a full or partial delta short would have returned (price P&L + funding)
 *   2. Actual IL accumulated over the period
 *   3. Combined LP + hedge P&L vs LP-only
 *   4. Whether the regime signal at entry justified the hedge
 *
 * Usage:
 *   bun .opencode/skills/hedge-retrospective/hedge-retrospective.ts [tokenId] [--days N] [--size 0.5] [--json]
 *
 * Options:
 *   tokenId       LP position token ID (default: first active position)
 *   --days N      Lookback window in days (default: since position open, max 90)
 *   --size 0.5    Fraction of HYPE delta to short (default: 1.0 = full hedge)
 *   --json        Machine-readable output
 *
 * Examples:
 *   bun hedge-retrospective.ts 484645
 *   bun hedge-retrospective.ts 484645 --days 7 --json
 *   bun hedge-retrospective.ts 484645 --size 0.5
 */

import { execSync } from "child_process";
import * as path from "path";

// HyperEVM RPC uses a custom CA — disable TLS verification (same as packages/core/src/chain/client.ts)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const jsonMode = process.argv.includes("--json");

const tokenIdArg = process.argv.find(
  (a) =>
    !a.startsWith("--") &&
    !a.includes("hedge-retrospective") &&
    !a.includes("bun") &&
    !a.endsWith(".ts") &&
    /^\d+$/.test(a),
);

const daysArgIdx = process.argv.indexOf("--days");
const daysArg = daysArgIdx !== -1 ? parseFloat(process.argv[daysArgIdx + 1]) : null;

const sizeArgIdx = process.argv.indexOf("--size");
const hedgeSize = sizeArgIdx !== -1 ? parseFloat(process.argv[sizeArgIdx + 1]) : 1.0;

// --stop PRICE  simulate a stop-loss order at this price; detected using daily candle highs
const stopArgIdx = process.argv.indexOf("--stop");
const stopPriceArg = stopArgIdx !== -1 ? parseFloat(process.argv[stopArgIdx + 1]) : null;

// --entry PRICE  override the short entry price (default: LP entry from position data)
const entryArgIdx = process.argv.indexOf("--entry");
const entryPriceArg = entryArgIdx !== -1 ? parseFloat(process.argv[entryArgIdx + 1]) : null;

const HL_API = "https://api.hyperliquid.xyz/info";
const HL_RPC = "https://rpc.hyperliquid.xyz/evm";

// ─── Types ──────────────────────────────────────────────────────────────────

interface LpPosition {
  tokenId: string;
  pair: string;
  token0Symbol: string;
  status: string;
  entryPrice: number;
  exitPrice: number;
  entryAmount0: number;
  exitAmount0: number;
  feesValueInToken1: number;
  entryValueInToken1: number;
  exitValueInToken1: number;
  holdValueInToken1: number;
  absolutePnlInToken1: number;
  divergenceLossPercent: number;
  opportunityCostInToken1: number;
  netVsHodlPercent: number;
  priceLower: number;
  priceUpper: number;
}

interface DailyRow {
  date: string;
  price: number;   // close
  high: number;    // candle high — used for stop-out detection
  shortDayPnl: number;
  fundingEarned: number;
  stopTriggered: boolean; // true if candle high >= stop price on this day
}

interface RetroReport {
  tokenId: string;
  pair: string;
  fetchedAt: string;
  periodDays: number;
  entryPrice: number;
  exitPrice: number;
  priceChangePct: number;
  hedgeSize: number;
  hypeShorted: number;
  hypeNotionalUsd: number;
  shortEntryPrice: number; // actual short entry price (may differ from LP entry if --entry supplied)

  // LP
  lpAbsolutePnlUsd: number;
  lpFeesUsd: number;
  lpIlUsd: number;
  lpNetVsHodlUsd: number;

  // Hedge
  shortPricePnlUsd: number;
  fundingEarnedUsd: number;
  totalHedgePnlUsd: number;
  stopPrice: number | null;         // stop price if --stop was provided
  stoppedOutAt: string | null;      // date stop triggered, or null
  stoppedOutLoss: number | null;    // realized short loss at stop, or null

  // Combined
  combinedPnlUsd: number;
  hedgeBenefitUsd: number;
  hedgeBenefitPct: number; // relative to entry value

  // Regime at entry
  regimeAtEntry: string;
  driftVolRatioAtEntry: number;
  dailyVolAtEntry: number;          // 1-sigma daily vol at entry — contextualises how tight the stop was
  volStopLevel: number;             // entry × (1 + 1.5 × dailyVolAtEntry) — what a vol-appropriate stop looks like
  regimeJustifiedHedge: boolean;

  // Daily breakdown
  dailyRows: DailyRow[];

  // Verdict
  wasHedgeWorthIt: boolean;
  analysis: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function repoRoot(): string {
  return execSync("git rev-parse --show-toplevel").toString().trim();
}

async function fetchLpPositions(): Promise<LpPosition[]> {
  const root = repoRoot();
  const cli = path.join(root, "apps/cli/src/index.ts");
  const out = execSync(`bun run "${cli}" --json pnl 2>/dev/null`, {
    encoding: "utf8",
  });
  const data = JSON.parse(out) as { positions: LpPosition[] };
  return data.positions;
}

async function fetchOpenTimestamp(tokenId: string): Promise<number | null> {
  const root = repoRoot();
  const configPath = path.join(root, "config.json");
  try {
    const raw = await Bun.file(configPath).text();
    const cfg = JSON.parse(raw) as {
      rpc: string;
      positions?: Record<string, { openTx?: string }>;
    };
    const openTx = cfg.positions?.[tokenId]?.openTx;
    if (!openTx) return null;

    const rpcRes = await fetch(cfg.rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_getTransactionByHash",
        id: 1,
        params: [openTx],
      }),
    });
    const txData = (await rpcRes.json()) as { result: { blockNumber: string } };
    const blockNum = txData.result?.blockNumber;
    if (!blockNum) return null;

    const blockRes = await fetch(cfg.rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_getBlockByNumber",
        id: 1,
        params: [blockNum, false],
      }),
    });
    const blockData = (await blockRes.json()) as { result: { timestamp: string } };
    const ts = blockData.result?.timestamp;
    return ts ? parseInt(ts, 16) : null;
  } catch {
    return null;
  }
}

interface HlCandle {
  t: number; // open time ms
  T: number; // close time ms
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
}

async function fetchDailyPrices(
  coin: string,
  startTimeMs: number,
  endTimeMs: number,
): Promise<{ date: string; price: number; high: number; timestamp: number }[]> {
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: { coin, interval: "1d", startTime: startTimeMs, endTime: endTimeMs },
    }),
  });
  if (!res.ok) throw new Error(`Hyperliquid candleSnapshot error: ${res.status}`);
  const candles = (await res.json()) as HlCandle[];
  return candles.map((c) => ({
    timestamp: c.t,
    date: new Date(c.t).toISOString().split("T")[0],
    price: parseFloat(c.c),
    high: parseFloat(c.h),
  }));
}

async function fetchFundingHistory(
  coin: string,
  startTimeMs: number,
): Promise<{ time: number; rate: number }[]> {
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "fundingHistory", coin, startTime: startTimeMs }),
  });
  if (!res.ok) throw new Error(`Hyperliquid funding history error: ${res.status}`);
  const data = (await res.json()) as { time: string; fundingRate: string }[];
  return data.map((e) => ({ time: parseInt(e.time), rate: parseFloat(e.fundingRate) }));
}

async function fetchRegimeAtDate(
  coin: string,
  entryTimestampMs: number,
): Promise<{ ratio: number; regime: string; dailyVol: number }> {
  const startTimeMs = entryTimestampMs - 32 * 86400_000;
  const endTimeMs = entryTimestampMs;
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: { coin, interval: "1d", startTime: startTimeMs, endTime: endTimeMs },
    }),
  });
  if (!res.ok) throw new Error(`Hyperliquid candleSnapshot error: ${res.status}`);
  const candles = (await res.json()) as HlCandle[];
  const prices = candles.map((c) => parseFloat(c.c));
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const vol = Math.sqrt(variance);
  const ratio = vol > 0 ? Math.abs(mean) / vol : 0;
  const regime = ratio < 0.5 ? "range-bound" : ratio <= 1.0 ? "mild-trend" : "strong-trend";
  return { ratio, regime, dailyVol: vol };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const positions = await fetchLpPositions();
  const allPositions = positions; // include closed too for retrospective

  const pos = tokenIdArg
    ? allPositions.find((p) => p.tokenId === tokenIdArg)
    : allPositions.find((p) => p.status === "active");

  if (!pos) throw new Error(`Position ${tokenIdArg ?? "(active)"} not found.`);

  const perpSymbol = pos.token0Symbol.replace(/^W/, "");

  // Read actual hedge config from config.json if present (used as default for --entry and --stop)
  const root = repoRoot();
  const configRaw = await Bun.file(path.join(root, "config.json")).text();
  const cfg = JSON.parse(configRaw) as {
    rpc: string;
    positions?: Record<string, { openTx?: string }>;
    hedge?: Record<string, {
      entryPriceHype?: number;
      sizeHype?: number;
      stopLossPriceHype?: number;
    }>;
  };
  const hedgeCfg = cfg.hedge?.[pos.tokenId];

  const openTs = await fetchOpenTimestamp(pos.tokenId);
  const nowTs = Date.now() / 1000;
  const maxDays = openTs ? (nowTs - openTs) / 86400 : 30;
  const periodDays = daysArg ? Math.min(daysArg, maxDays) : maxDays;

  const startTimeMs = Math.floor((nowTs - periodDays * 86400) * 1000);
  const endTimeMs = Date.now();
  const entryTimestampMs = openTs ? Math.floor(openTs * 1000) : startTimeMs;

  // Fetch in parallel
  const [dailyPrices, fundingHistory, regimeAtEntry] = await Promise.all([
    fetchDailyPrices(perpSymbol, startTimeMs, endTimeMs),
    fetchFundingHistory(perpSymbol, startTimeMs),
    fetchRegimeAtDate(perpSymbol, entryTimestampMs),
  ]);

  const trimmedPrices = dailyPrices;
  if (trimmedPrices.length < 2)
    throw new Error("Insufficient price data for the requested period.");

  // Short entry: --entry flag > config.hedge[tokenId].entryPriceHype > first daily close
  const shortEntryPrice = entryPriceArg ?? hedgeCfg?.entryPriceHype ?? trimmedPrices[0].price;

  // Stop price: --stop flag > config.hedge[tokenId].stopLossPriceHype > null (no stop)
  const stopPrice = stopPriceArg ?? hedgeCfg?.stopLossPriceHype ?? null;

  const entryPrice = trimmedPrices[0].price; // LP price reference (first candle)
  const exitPrice = trimmedPrices[trimmedPrices.length - 1].price;

  // HYPE exposure: config.hedge size > entryAmount0 * hedgeSize fraction
  const hypeAtEntry = pos.entryAmount0;
  const configuredSize = hedgeCfg?.sizeHype;
  const hypeShorted = configuredSize ?? (hypeAtEntry * hedgeSize);

  // Daily funding grouped by date
  const dailyFunding: Record<string, number> = {};
  for (const entry of fundingHistory) {
    const dt = new Date(entry.time).toISOString().split("T")[0];
    const avgPrice =
      trimmedPrices.find((p) => p.date === dt)?.price ?? (entryPrice + exitPrice) / 2;
    dailyFunding[dt] = (dailyFunding[dt] ?? 0) + entry.rate * avgPrice * hypeShorted;
  }

  // Build daily rows with stop-out detection
  const dailyRows: DailyRow[] = [];
  let prevPrice = shortEntryPrice;
  let stoppedOutAt: string | null = null;
  let stoppedOutLoss: number | null = null;

  for (const { date, price, high } of trimmedPrices.slice(1)) {
    // If already stopped out, don't add more rows
    if (stoppedOutAt !== null) break;

    const stopTriggered = stopPrice !== null && high >= stopPrice;

    if (stopTriggered) {
      // Stop fires at stopPrice on this candle; short loss is (stopPrice - shortEntryPrice) * size
      const stopLoss = (stopPrice! - shortEntryPrice) * hypeShorted;
      const fundingEarned = dailyFunding[date] ?? 0;
      stoppedOutAt = date;
      stoppedOutLoss = -stopLoss; // negative = loss for a short
      dailyRows.push({ date, price: stopPrice!, high, shortDayPnl: -stopLoss, fundingEarned, stopTriggered: true });
    } else {
      const shortDayPnl = (prevPrice - price) * hypeShorted;
      const fundingEarned = dailyFunding[date] ?? 0;
      dailyRows.push({ date, price, high, shortDayPnl, fundingEarned, stopTriggered: false });
      prevPrice = price;
    }
  }

  // Aggregate
  const shortPricePnlUsd = dailyRows.reduce((s, r) => s + r.shortDayPnl, 0);
  const fundingEarnedUsd = dailyRows.reduce((s, r) => s + r.fundingEarned, 0);
  const totalHedgePnlUsd = shortPricePnlUsd + fundingEarnedUsd;

  // LP actuals (from position data)
  const lpAbsolutePnlUsd = pos.absolutePnlInToken1;
  const lpFeesUsd = pos.feesValueInToken1;
  const lpIlUsd = Math.abs(pos.opportunityCostInToken1);
  const lpNetVsHodlUsd = pos.netVsHodlPercent * pos.entryValueInToken1;

  // Combined
  const combinedPnlUsd = lpAbsolutePnlUsd + totalHedgePnlUsd;
  const hedgeBenefitUsd = combinedPnlUsd - lpAbsolutePnlUsd;
  const hedgeBenefitPct = hedgeBenefitUsd / pos.entryValueInToken1;

  // Vol-appropriate stop reference
  const dailyVolAtEntry = regimeAtEntry.dailyVol;
  const volStopLevel = shortEntryPrice * (1 + 1.5 * dailyVolAtEntry);

  const regimeJustifiedHedge =
    regimeAtEntry.regime === "mild-trend" || regimeAtEntry.regime === "strong-trend";

  const priceChangePct = (exitPrice - entryPrice) / entryPrice;

  // Was it worth it?
  // If stopped out: it was worth it only if the stop loss was < IL that was ultimately avoided
  // Otherwise: hedge covered at least 50% of IL
  let wasHedgeWorthIt: boolean;
  if (stoppedOutAt !== null) {
    wasHedgeWorthIt = totalHedgePnlUsd > 0 || (stoppedOutLoss !== null && Math.abs(stoppedOutLoss!) < lpIlUsd * 0.5);
  } else {
    wasHedgeWorthIt = totalHedgePnlUsd > lpIlUsd * 0.5;
  }

  let analysis: string;
  const stoppedNote = stoppedOutAt
    ? ` Stop fired on ${stoppedOutAt} at $${stopPrice!.toFixed(2)} — only ${dailyRows.length} day(s) of hedge coverage. Vol-appropriate stop (1.5σ) would have been $${volStopLevel.toFixed(2)}.`
    : "";

  if (wasHedgeWorthIt && !regimeJustifiedHedge) {
    analysis = `The hedge was profitable (+$${totalHedgePnlUsd.toFixed(2)}) but the regime at entry (${regimeAtEntry.regime}, ratio ${regimeAtEntry.ratio.toFixed(3)}) did not justify it systematically — it was a directional call that paid off.${stoppedNote}`;
  } else if (wasHedgeWorthIt && regimeJustifiedHedge) {
    analysis = `The hedge was profitable (+$${totalHedgePnlUsd.toFixed(2)}) and the regime (${regimeAtEntry.regime}) supported it. Good execution.${stoppedNote}`;
  } else if (!wasHedgeWorthIt && regimeJustifiedHedge) {
    analysis = `The hedge underperformed ($${totalHedgePnlUsd.toFixed(2)} vs $${lpIlUsd.toFixed(2)} IL), but the regime signal was valid. Execution timing was the issue.${stoppedNote}`;
  } else {
    analysis = `Hedge was not worth it ($${totalHedgePnlUsd.toFixed(2)} vs $${lpIlUsd.toFixed(2)} IL) and regime (${regimeAtEntry.regime}, ratio ${regimeAtEntry.ratio.toFixed(3)}) did not support it.${stoppedNote}`;
  }

  const report: RetroReport = {
    tokenId: pos.tokenId,
    pair: pos.pair,
    fetchedAt: new Date().toISOString(),
    periodDays,
    entryPrice,
    exitPrice,
    priceChangePct,
    hedgeSize,
    hypeShorted,
    hypeNotionalUsd: hypeShorted * shortEntryPrice,
    shortEntryPrice,
    lpAbsolutePnlUsd,
    lpFeesUsd,
    lpIlUsd,
    lpNetVsHodlUsd,
    shortPricePnlUsd,
    fundingEarnedUsd,
    totalHedgePnlUsd,
    stopPrice,
    stoppedOutAt,
    stoppedOutLoss,
    combinedPnlUsd,
    hedgeBenefitUsd,
    hedgeBenefitPct,
    regimeAtEntry: regimeAtEntry.regime,
    driftVolRatioAtEntry: regimeAtEntry.ratio,
    dailyVolAtEntry,
    volStopLevel,
    regimeJustifiedHedge,
    dailyRows,
    wasHedgeWorthIt,
    analysis,
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // ── Human-readable ──────────────────────────────────────────────────────
  const usd = (n: number) => (n >= 0 ? "+" : "") + "$" + Math.abs(n).toFixed(2) + (n < 0 ? " (loss)" : "");
  const pct = (n: number) => (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%";

  console.log(`\n## Hedge Retrospective: ${report.pair} (#${report.tokenId})`);
  console.log(`Period: ${periodDays.toFixed(1)} days   Hedge size: ${hypeShorted.toFixed(1)} ${perpSymbol} short @ $${shortEntryPrice.toFixed(2)}`);
  if (stopPrice) console.log(`Stop loss: $${stopPrice.toFixed(2)}${stoppedOutAt ? `  ← TRIGGERED on ${stoppedOutAt}` : "  (not triggered)"}`);
  console.log(`Price: $${entryPrice.toFixed(2)} → $${exitPrice.toFixed(2)}  (${pct(priceChangePct)})\n`);

  console.log("### LP (Actual)");
  console.log(`  Absolute P&L:    ${usd(lpAbsolutePnlUsd)}`);
  console.log(`  Fees earned:     +$${lpFeesUsd.toFixed(2)}`);
  console.log(`  IL (opp. cost):  -$${lpIlUsd.toFixed(2)}`);
  console.log(`  Net vs HODL:     ${usd(lpNetVsHodlUsd)}`);

  console.log("\n### Short Hedge (Simulated)");
  console.log(`  ${hypeShorted.toFixed(2)} ${perpSymbol} shorted at $${shortEntryPrice.toFixed(2)}`);
  if (stopPrice) console.log(`  Stop at $${stopPrice.toFixed(2)}  (${((stopPrice / shortEntryPrice - 1) * 100).toFixed(1)}% buffer)  |  1.5σ vol stop: $${volStopLevel.toFixed(2)}`);
  console.log(`  Price P&L:       ${usd(shortPricePnlUsd)}`);
  console.log(`  Funding earned:  +$${fundingEarnedUsd.toFixed(2)}`);
  console.log(`  Total hedge P&L: ${usd(totalHedgePnlUsd)}`);
  if (stoppedOutAt) console.log(`  ⚠ Stopped out on ${stoppedOutAt} — only ${dailyRows.length} day(s) of coverage`);

  console.log("\n### Combined (LP + Hedge)");
  console.log(`  LP only:         ${usd(lpAbsolutePnlUsd)}`);
  console.log(`  LP + hedge:      ${usd(combinedPnlUsd)}`);
  console.log(`  Hedge benefit:   ${usd(hedgeBenefitUsd)}  (${pct(hedgeBenefitPct)} of entry)`);

  console.log("\n### Regime at Entry");
  console.log(`  Drift/vol ratio: ${regimeAtEntry.ratio.toFixed(3)}  →  ${regimeAtEntry.regime.toUpperCase()}`);
  console.log(`  Daily vol:       ${(dailyVolAtEntry * 100).toFixed(2)}%  |  1.5σ vol stop: $${volStopLevel.toFixed(2)}`);
  console.log(`  Regime justified hedge: ${regimeJustifiedHedge ? "YES" : "NO"}`);

  console.log("\n### Daily Breakdown");
  console.log(`  ${"Date".padEnd(12)}| ${"Price".padEnd(8)}| ${"High".padEnd(8)}| ${"Short P&L".padEnd(11)}| ${"Funding".padEnd(9)}| Row Total`);
  console.log(`  ${"-".repeat(60)}`);
  for (const row of report.dailyRows) {
    const rowTotal = row.shortDayPnl + row.fundingEarned;
    const stopFlag = row.stopTriggered ? " ← STOP" : "";
    console.log(
      `  ${row.date.padEnd(12)}` +
      `| $${row.price.toFixed(2).padStart(6)} ` +
      `| $${row.high.toFixed(2).padStart(6)} ` +
      `| ${(row.shortDayPnl >= 0 ? "+" : "")}$${row.shortDayPnl.toFixed(2).padStart(8)} ` +
      `| $${row.fundingEarned.toFixed(3).padStart(7)} ` +
      `| ${rowTotal >= 0 ? "+" : ""}$${rowTotal.toFixed(2)}${stopFlag}`,
    );
  }

  console.log("\n### Verdict");
  console.log(`  Was hedge worth it: ${wasHedgeWorthIt ? "YES" : "NO"}`);
  console.log(`  ${analysis}`);
  console.log();
}

main().catch((err: Error) => {
  console.error("Error:", err.message);
  process.exit(1);
});
