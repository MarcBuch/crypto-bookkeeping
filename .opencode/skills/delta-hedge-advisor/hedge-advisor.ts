#!/usr/bin/env bun
/**
 * hedge-advisor.ts — Delta hedge go/no-go for an active LP position.
 *
 * Combines in a single pass:
 *   1. LP position data (via lp-tracker CLI)
 *   2. Live funding rate from Hyperliquid perps API
 *   3. 30-day drift/vol regime (CoinGecko)
 *   4. Fee run rate (derived from open tx block timestamp)
 *
 * Decision equation:
 *   Hedge worthwhile if:
 *     expected_additional_IL > (funding_rate × notional × horizon) + friction
 *
 * Usage:
 *   bun .opencode/skills/delta-hedge-advisor/hedge-advisor.ts [tokenId] [--json]
 *
 * Examples:
 *   bun hedge-advisor.ts                  # uses first active position
 *   bun hedge-advisor.ts 484645
 *   bun hedge-advisor.ts 484645 --json
 */

import { execSync } from "child_process";
import * as path from "path";

// HyperEVM RPC uses a custom CA — disable TLS verification (same as packages/core/src/chain/client.ts)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const jsonMode = process.argv.includes("--json");

const tokenIdArg = process.argv.find(
  (a) =>
    !a.startsWith("--") &&
    !a.includes("hedge-advisor") &&
    !a.includes("bun") &&
    !a.endsWith(".ts") &&
    /^\d+$/.test(a),
);

const COINGECKO_API = "https://api.coingecko.com/api/v3";
const HL_API = "https://api.hyperliquid.xyz/info";
const HL_RPC = "https://rpc.hyperliquid.xyz/evm";

// ─── Types ──────────────────────────────────────────────────────────────────

interface LpPosition {
  tokenId: string;
  pair: string;
  token0Symbol: string;
  token1Symbol: string;
  status: string;
  entryPrice: number;
  exitPrice: number;
  priceChangePercent: number;
  entryAmount0: number;
  exitAmount0: number;
  feesValueInToken1: number;
  entryValueInToken1: number;
  exitValueInToken1: number;
  holdValueInToken1: number;
  absolutePnlInToken1: number;
  absolutePnlPercent: number;
  divergenceLossPercent: number;
  opportunityCostInToken1: number;
  netVsHodlPercent: number;
  priceLower: number;
  priceUpper: number;
}

interface HedgeReport {
  tokenId: string;
  pair: string;
  fetchedAt: string;

  // Position
  entryPrice: number;
  currentPrice: number;
  priceLower: number;
  priceUpper: number;
  pctToLowerBound: number;
  pctToUpperBound: number;

  // IL
  ilPercent: number;
  ilUsd: number;
  feesUsd: number;
  netVsHodlUsd: number;
  daysOpen: number;
  dailyFeeUsd: number;
  annualizedFeeYield: number; // as decimal

  // Delta
  hypeExposure: number; // in HYPE tokens
  hypeNotionalUsd: number;

  // Funding
  hourlyFundingRate: number;
  dailyFundingRate: number;
  annualizedFundingRate: number;
  dailyFundingEarned: number; // if short placed
  fundingAsPctOfFees: number;

  // Regime
  driftVolRatio: number;
  regime: string;

  // Verdict
  verdict: "no-hedge" | "consider-hedge" | "hedge-recommended";
  verdictReason: string;
  hedgeBreakEvenDays: number | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function repoRoot(): string {
  return execSync("git rev-parse --show-toplevel").toString().trim();
}

async function fetchLpPositions(): Promise<LpPosition[]> {
  const root = repoRoot();
  const cli = path.join(root, "apps/cli/src/index.ts");
  try {
    const out = execSync(`bun run "${cli}" --json pnl 2>/dev/null`, {
      encoding: "utf8",
    });
    const data = JSON.parse(out) as { positions: LpPosition[] };
    return data.positions;
  } catch {
    throw new Error("Failed to fetch LP positions from CLI");
  }
}

async function fetchFundingRate(coin: string): Promise<number> {
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  if (!res.ok) throw new Error(`Hyperliquid API error: ${res.status}`);
  const data = (await res.json()) as [
    { universe: { name: string }[] },
    { funding: string; markPx: string }[],
  ];
  const idx = data[0].universe.findIndex((a) => a.name === coin);
  if (idx === -1) throw new Error(`Coin ${coin} not found in Hyperliquid`);
  return parseFloat(data[1][idx].funding);
}

async function fetchDriftVolRatio(coinId: string): Promise<{ ratio: number; regime: string }> {
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

function verdictFromSignals(
  ilUsd: number,
  dailyFeeUsd: number,
  regime: string,
  driftVolRatio: number,
  pctToLowerBound: number,
): { verdict: HedgeReport["verdict"]; reason: string } {
  if (regime === "strong-trend") {
    return {
      verdict: "hedge-recommended",
      reason:
        "Strong trend regime (drift/vol > 1.0) — LP is selling into a directional move. Hedge delta or close position.",
    };
  }

  const ilCoveredInDays = dailyFeeUsd > 0 ? ilUsd / dailyFeeUsd : Infinity;

  if (regime === "range-bound" && ilCoveredInDays < 2 && pctToLowerBound > 20) {
    return {
      verdict: "no-hedge",
      reason: `Range-bound regime, fees covering IL in ${ilCoveredInDays.toFixed(1)} days, ${pctToLowerBound.toFixed(0)}% buffer to lower bound. No hedge needed.`,
    };
  }

  if (regime === "mild-trend" || driftVolRatio > 0.4) {
    return {
      verdict: "consider-hedge",
      reason: `Mild-trend signal (drift/vol = ${driftVolRatio.toFixed(3)}). Consider partial delta hedge (50% of HYPE exposure) to reduce directional risk.`,
    };
  }

  if (pctToLowerBound < 10) {
    return {
      verdict: "consider-hedge",
      reason: `Price is within ${pctToLowerBound.toFixed(1)}% of lower bound. Out-of-range risk is elevated — consider hedging delta to protect downside.`,
    };
  }

  return {
    verdict: "no-hedge",
    reason: `Range-bound regime, IL small relative to fee run rate (covered in ${ilCoveredInDays.toFixed(1)} days). No systematic basis for hedge.`,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const positions = await fetchLpPositions();
  const active = positions.filter((p) => p.status === "active");
  if (active.length === 0) throw new Error("No active LP positions found.");

  const pos = tokenIdArg
    ? active.find((p) => p.tokenId === tokenIdArg)
    : active[0];

  if (!pos) throw new Error(`No active position found for tokenId ${tokenIdArg}`);

  // Determine perp symbol (strip W prefix from wrapped token)
  const perpSymbol = pos.token0Symbol.replace(/^W/, "");
  const cgId = perpSymbol === "HYPE" ? "hyperliquid" : perpSymbol.toLowerCase();

  const [fundingRate, { ratio: driftVolRatio, regime }, openTs] = await Promise.all([
    fetchFundingRate(perpSymbol),
    fetchDriftVolRatio(cgId),
    fetchOpenTimestamp(pos.tokenId),
  ]);

  const now = Date.now() / 1000;
  const daysOpen = openTs ? (now - openTs) / 86400 : null;
  const dailyFeeUsd = daysOpen && daysOpen > 0 ? pos.feesValueInToken1 / daysOpen : null;

  const currentPrice = pos.exitPrice;
  const hypeExposure = pos.exitAmount0;
  const hypeNotionalUsd = hypeExposure * currentPrice;

  // IL in USD (opportunity cost)
  const ilUsd = Math.abs(pos.opportunityCostInToken1);
  const ilPercent = Math.abs(pos.divergenceLossPercent);

  // Funding calcs (hourly rate × 24 = daily)
  const dailyFundingRate = fundingRate * 24;
  const annualizedFundingRate = dailyFundingRate * 365;
  const dailyFundingEarned = dailyFundingRate * hypeNotionalUsd;
  const fundingAsPctOfFees = dailyFeeUsd ? dailyFundingEarned / dailyFeeUsd : 0;

  // Range proximity
  const pctToLowerBound = ((currentPrice - pos.priceLower) / currentPrice) * 100;
  const pctToUpperBound = ((pos.priceUpper - currentPrice) / currentPrice) * 100;

  // Annualized fee yield
  const annualizedFeeYield =
    daysOpen && daysOpen > 0
      ? (pos.feesValueInToken1 / pos.entryValueInToken1) * (365 / daysOpen)
      : 0;

  // Hedge break-even: how many days until funding earned = IL
  const hedgeBreakEvenDays =
    dailyFundingEarned > 0 ? ilUsd / dailyFundingEarned : null;

  const { verdict, reason: verdictReason } = verdictFromSignals(
    ilUsd,
    dailyFeeUsd ?? 0,
    regime,
    driftVolRatio,
    pctToLowerBound,
  );

  const report: HedgeReport = {
    tokenId: pos.tokenId,
    pair: pos.pair,
    fetchedAt: new Date().toISOString(),
    entryPrice: pos.entryPrice,
    currentPrice,
    priceLower: pos.priceLower,
    priceUpper: pos.priceUpper,
    pctToLowerBound,
    pctToUpperBound,
    ilPercent,
    ilUsd,
    feesUsd: pos.feesValueInToken1,
    netVsHodlUsd: pos.netVsHodlPercent * pos.entryValueInToken1,
    daysOpen: daysOpen ?? 0,
    dailyFeeUsd: dailyFeeUsd ?? 0,
    annualizedFeeYield,
    hypeExposure,
    hypeNotionalUsd,
    hourlyFundingRate: fundingRate,
    dailyFundingRate,
    annualizedFundingRate,
    dailyFundingEarned,
    fundingAsPctOfFees,
    driftVolRatio,
    regime,
    verdict,
    verdictReason,
    hedgeBreakEvenDays,
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // ── Human-readable ──────────────────────────────────────────────────────
  const pct = (n: number, d = 2) => (n * 100).toFixed(d) + "%";
  const usd = (n: number) => "$" + n.toFixed(2);

  console.log(`\n## Delta Hedge Advisor: ${report.pair} (#${report.tokenId})`);
  console.log(`Fetched: ${report.fetchedAt}\n`);

  console.log("### Position");
  console.log(`  Entry:   ${usd(report.entryPrice)}   Current: ${usd(report.currentPrice)}`);
  console.log(
    `  Range:   ${usd(report.priceLower)} – ${usd(report.priceUpper)}`,
  );
  console.log(
    `  Buffer:  ${report.pctToLowerBound.toFixed(1)}% to lower  /  ${report.pctToUpperBound.toFixed(1)}% to upper`,
  );

  console.log("\n### IL & Fees");
  console.log(`  Divergence loss:  ${pct(-ilPercent)}  (${usd(-ilUsd)})`);
  console.log(`  Fees earned:      ${usd(report.feesUsd)}`);
  console.log(`  Net vs HODL:      ${usd(report.netVsHodlUsd)}`);
  if (daysOpen) {
    console.log(
      `  Days open:        ${daysOpen.toFixed(1)}  →  ${usd(report.dailyFeeUsd)}/day  (${pct(annualizedFeeYield)} annualized)`,
    );
  }

  console.log("\n### Delta Exposure");
  console.log(
    `  ${perpSymbol} in LP:   ${report.hypeExposure.toFixed(2)} ${perpSymbol}  (${usd(report.hypeNotionalUsd)})`,
  );

  console.log("\n### Funding Rate (Hyperliquid Perps)");
  console.log(`  Hourly:      ${pct(fundingRate, 5)}`);
  console.log(`  Daily:       ${pct(dailyFundingRate, 4)}`);
  console.log(`  Annualized:  ${pct(annualizedFundingRate, 2)}`);
  console.log(
    `  Shorts earn: ${usd(dailyFundingEarned)}/day  (${pct(fundingAsPctOfFees)} of fee income)`,
  );

  console.log("\n### Market Regime");
  console.log(`  Drift/vol ratio: ${driftVolRatio.toFixed(3)}  →  ${regime.toUpperCase()}`);

  console.log("\n### Hedge Break-even");
  if (hedgeBreakEvenDays !== null) {
    console.log(
      `  Funding alone covers IL in: ${hedgeBreakEvenDays.toFixed(0)} days`,
    );
  } else {
    console.log("  N/A");
  }

  console.log("\n### Verdict");
  const icons = { "no-hedge": "✗", "consider-hedge": "△", "hedge-recommended": "✓" };
  console.log(`  ${icons[verdict]}  ${verdict.toUpperCase()}`);
  console.log(`  ${verdictReason}`);
  console.log();
}

main().catch((err: Error) => {
  console.error("Error:", err.message);
  process.exit(1);
});
