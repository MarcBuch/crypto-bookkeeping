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

const COINGECKO_API = "https://api.coingecko.com/api/v3";
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
  price: number;
  shortDayPnl: number;
  fundingEarned: number;
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

  // LP
  lpAbsolutePnlUsd: number;
  lpFeesUsd: number;
  lpIlUsd: number;
  lpNetVsHodlUsd: number;

  // Hedge
  shortPricePnlUsd: number;
  fundingEarnedUsd: number;
  totalHedgePnlUsd: number;

  // Combined
  combinedPnlUsd: number;
  hedgeBenefitUsd: number;
  hedgeBenefitPct: number; // relative to entry value

  // Regime at entry
  regimeAtEntry: string;
  driftVolRatioAtEntry: number;
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

async function fetchDailyPrices(
  coinId: string,
  days: number,
): Promise<{ date: string; price: number }[]> {
  const cgDays = Math.min(Math.ceil(days) + 2, 90);
  const url = `${COINGECKO_API}/coins/${coinId}/market_chart?vs_currency=usd&days=${cgDays}&interval=daily`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);
  const data = (await res.json()) as { prices: [number, number][] };
  return data.prices.map(([ts, price]) => ({
    date: new Date(ts).toISOString().split("T")[0],
    price,
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
  coinId: string,
  daysAgo: number,
): Promise<{ ratio: number; regime: string }> {
  // Fetch 31 days ending at daysAgo to simulate what regime looked like at entry
  // CoinGecko free tier only supports rolling windows — approximate with current 30d if entry is recent
  const url = `${COINGECKO_API}/coins/${coinId}/market_chart?vs_currency=usd&days=31&interval=daily`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);
  const raw = (await res.json()) as { prices: [number, number][] };
  const prices = raw.prices.map(([, p]) => p);
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const vol = Math.sqrt(variance);
  const ratio = vol > 0 ? Math.abs(mean) / vol : 0;
  const regime = ratio < 0.5 ? "range-bound" : ratio <= 1.0 ? "mild-trend" : "strong-trend";
  return { ratio, regime };
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
  const cgId = perpSymbol === "HYPE" ? "hyperliquid" : perpSymbol.toLowerCase();

  const openTs = await fetchOpenTimestamp(pos.tokenId);
  const nowTs = Date.now() / 1000;
  const maxDays = openTs ? (nowTs - openTs) / 86400 : 30;
  const periodDays = daysArg ? Math.min(daysArg, maxDays) : maxDays;

  const startTs = openTs ?? nowTs - periodDays * 86400;
  const startTimeMs = Math.floor((nowTs - periodDays * 86400) * 1000);

  // Fetch in parallel
  const [dailyPrices, fundingHistory, regimeAtEntry] = await Promise.all([
    fetchDailyPrices(cgId, periodDays),
    fetchFundingHistory(perpSymbol, startTimeMs),
    fetchRegimeAtDate(cgId, periodDays),
  ]);

  // Trim prices to period
  const startDateStr = new Date(startTimeMs).toISOString().split("T")[0];
  const trimmedPrices = dailyPrices.filter((p) => p.date >= startDateStr);
  if (trimmedPrices.length < 2)
    throw new Error("Insufficient price data for the requested period.");

  const entryPrice = trimmedPrices[0].price;
  const exitPrice = trimmedPrices[trimmedPrices.length - 1].price;

  // HYPE exposure at entry (use entry amount from position)
  const hypeAtEntry = pos.entryAmount0;
  const hypeShorted = hypeAtEntry * hedgeSize;

  // Daily funding grouped by date
  const dailyFunding: Record<string, number> = {};
  for (const entry of fundingHistory) {
    const dt = new Date(entry.time).toISOString().split("T")[0];
    const avgPrice =
      trimmedPrices.find((p) => p.date === dt)?.price ?? (entryPrice + exitPrice) / 2;
    dailyFunding[dt] = (dailyFunding[dt] ?? 0) + entry.rate * avgPrice * hypeShorted;
  }

  // Build daily rows
  const dailyRows: DailyRow[] = [];
  let prevPrice = entryPrice;
  for (const { date, price } of trimmedPrices.slice(1)) {
    const shortDayPnl = (prevPrice - price) * hypeShorted; // profit when price falls
    const fundingEarned = dailyFunding[date] ?? 0;
    dailyRows.push({ date, price, shortDayPnl, fundingEarned });
    prevPrice = price;
  }

  // Aggregate
  const shortPricePnlUsd = dailyRows.reduce((s, r) => s + r.shortDayPnl, 0);
  const fundingEarnedUsd = dailyRows.reduce((s, r) => s + r.fundingEarned, 0);
  const totalHedgePnlUsd = shortPricePnlUsd + fundingEarnedUsd;

  // LP actuals (from position data — covers full position lifetime if period = full)
  const lpAbsolutePnlUsd = pos.absolutePnlInToken1;
  const lpFeesUsd = pos.feesValueInToken1;
  const lpIlUsd = Math.abs(pos.opportunityCostInToken1);
  const lpNetVsHodlUsd = pos.netVsHodlPercent * pos.entryValueInToken1;

  // Combined
  const combinedPnlUsd = lpAbsolutePnlUsd + totalHedgePnlUsd;
  const hedgeBenefitUsd = combinedPnlUsd - lpAbsolutePnlUsd;
  const hedgeBenefitPct = hedgeBenefitUsd / pos.entryValueInToken1;

  const regimeJustifiedHedge =
    regimeAtEntry.regime === "mild-trend" || regimeAtEntry.regime === "strong-trend";

  const priceChangePct = (exitPrice - entryPrice) / entryPrice;

  // Was it worth it?
  const wasHedgeWorthIt = totalHedgePnlUsd > lpIlUsd * 0.5; // hedge covered at least 50% of IL

  let analysis: string;
  if (wasHedgeWorthIt && !regimeJustifiedHedge) {
    analysis = `The hedge was profitable (+$${totalHedgePnlUsd.toFixed(2)}) but the regime at entry (${regimeAtEntry.regime}, ratio ${regimeAtEntry.driftVolRatioAtEntry ?? regimeAtEntry.ratio.toFixed(3)}) did not justify it systematically — it was a directional call that paid off.`;
  } else if (wasHedgeWorthIt && regimeJustifiedHedge) {
    analysis = `The hedge was profitable (+$${totalHedgePnlUsd.toFixed(2)}) and the regime (${regimeAtEntry.regime}) supported it. Good execution.`;
  } else if (!wasHedgeWorthIt && regimeJustifiedHedge) {
    analysis = `The hedge underperformed (+$${totalHedgePnlUsd.toFixed(2)} vs $${lpIlUsd.toFixed(2)} IL), but the regime signal was valid. Execution timing was the issue.`;
  } else {
    analysis = `Hedge was not worth it (+$${totalHedgePnlUsd.toFixed(2)} vs $${lpIlUsd.toFixed(2)} IL) and regime (${regimeAtEntry.regime}, ratio ${regimeAtEntry.ratio.toFixed(3)}) did not support it. Correct decision to skip.`;
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
    hypeNotionalUsd: hypeShorted * entryPrice,
    lpAbsolutePnlUsd,
    lpFeesUsd,
    lpIlUsd,
    lpNetVsHodlUsd,
    shortPricePnlUsd,
    fundingEarnedUsd,
    totalHedgePnlUsd,
    combinedPnlUsd,
    hedgeBenefitUsd,
    hedgeBenefitPct,
    regimeAtEntry: regimeAtEntry.regime,
    driftVolRatioAtEntry: regimeAtEntry.ratio,
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
  console.log(`Period: ${periodDays.toFixed(1)} days   Hedge size: ${(hedgeSize * 100).toFixed(0)}% of delta`);
  console.log(`${entryPrice.toFixed(2)} → ${exitPrice.toFixed(2)}  (${pct(priceChangePct)})\n`);

  console.log("### LP (Actual)");
  console.log(`  Absolute P&L:    ${usd(lpAbsolutePnlUsd)}`);
  console.log(`  Fees earned:     +$${lpFeesUsd.toFixed(2)}`);
  console.log(`  IL (opp. cost):  -$${lpIlUsd.toFixed(2)}`);
  console.log(`  Net vs HODL:     ${usd(lpNetVsHodlUsd)}`);

  console.log("\n### Short Hedge (Simulated)");
  console.log(`  ${hypeShorted.toFixed(2)} ${perpSymbol} shorted at $${entryPrice.toFixed(2)}`);
  console.log(`  Price P&L:       ${usd(shortPricePnlUsd)}`);
  console.log(`  Funding earned:  +$${fundingEarnedUsd.toFixed(2)}`);
  console.log(`  Total hedge P&L: ${usd(totalHedgePnlUsd)}`);

  console.log("\n### Combined (LP + Hedge)");
  console.log(`  LP only:         ${usd(lpAbsolutePnlUsd)}`);
  console.log(`  LP + hedge:      ${usd(combinedPnlUsd)}`);
  console.log(`  Hedge benefit:   ${usd(hedgeBenefitUsd)}  (${pct(hedgeBenefitPct)} of entry)`);

  console.log("\n### Regime at Entry");
  console.log(
    `  Drift/vol ratio: ${regimeAtEntry.ratio.toFixed(3)}  →  ${regimeAtEntry.regime.toUpperCase()}`,
  );
  console.log(
    `  Regime justified hedge: ${regimeJustifiedHedge ? "YES" : "NO"}`,
  );

  console.log("\n### Daily Breakdown");
  console.log("  Date        | Price  | Short P&L | Funding | Row Total");
  console.log("  ------------|--------|-----------|---------|----------");
  for (const row of report.dailyRows) {
    const rowTotal = row.shortDayPnl + row.fundingEarned;
    console.log(
      `  ${row.date} | $${row.price.toFixed(2).padStart(6)} | ${row.shortDayPnl >= 0 ? "+" : ""}$${row.shortDayPnl.toFixed(2).padStart(7)} | $${row.fundingEarned.toFixed(3).padStart(7)} | ${rowTotal >= 0 ? "+" : ""}$${rowTotal.toFixed(2)}`,
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
