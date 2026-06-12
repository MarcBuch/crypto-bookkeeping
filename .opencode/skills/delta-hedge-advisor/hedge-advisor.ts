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
  hypeExposure: number;             // current HYPE in LP
  hypeNotionalUsd: number;
  liquidityConstant: number;        // V3 L — used for gamma-aware sizing
  hypeExposureAtLowerBound: number; // max HYPE if price reaches lower bound
  hypeExposureAtUpperBound: number; // min HYPE if price reaches upper bound (= 0)

  // Funding
  hourlyFundingRate: number;
  dailyFundingRate: number;
  annualizedFundingRate: number;
  dailyFundingEarned: number; // if short placed
  fundingAsPctOfFees: number;

  // Regime
  driftVolRatio: number;
  regime: string;

  // Verdict (fee-optimisation framing)
  verdict: "no-hedge" | "consider-hedge" | "hedge-recommended";
  verdictReason: string;
  hedgeBreakEvenDays: number | null;

  // Capital preservation framing
  dailyIlRate: number;                // USD of IL accumulating per day
  hedgeCostToIlRatio: number;         // daily hedge cost / daily IL rate  (<1 means hedge is cheap vs IL)
  downsideScenarios: {
    dropPct: number;                  // e.g. 0.10 = 10% drop
    deltaLossUsd: number;             // directional loss on HYPE notional
    hedgeCarryToDateUsd: number;      // cost of hedge to reach that scenario (assume 7 days)
  }[];
  upsideScenarios: {
    risePct: number;                  // e.g. 0.10 = 10% rise
    newPrice: number;
    lpHypeAtPrice: number;            // HYPE remaining in LP at that price (V3 gamma)
    lpValueGainUsd: number;           // LP portfolio value gain vs current price
    shortLossUsd: number;             // mark-to-market loss on recommended short
    netCombinedUsd: number;           // shortLoss - lpValueGain (true combined cost)
    overhedgeHype: number;            // how many HYPE the short exceeds LP delta
    fees7dUsd: number;                // 7d fee income
    net7dUsd: number;                 // fees7d - shortLoss (+ funding)
  }[];
  recommendedHedgeHype: number;       // suggested short size (V3-aware)
  recommendedHedgeReason: string;
  hedgeCloseTriggerPrice: number;     // close short if price reaches this
  hedgeReduceTriggerPrice: number;    // reduce to 50% if price reaches this
  hedgeCloseTriggerReason: string;

  // Break-even hedge: size so short profit exactly covers LP loss at lower bound
  breakEvenHedge: {
    sizeHype: number;
    notionalUsd: number;
    lpLossAtLowerUsd: number;         // LP value lost if price hits lower bound
    lpValueAtLowerUsd: number;
    verificationUsd: number;          // lpValue + shortProfit (should ≈ currentLpValue)
  };

  // Stop loss scenarios: for candidate stops, true net cost after LP value gain
  stopLossScenarios: {
    stopPrice: number;
    bufferPct: number;                // % above current price
    shortLossUsd: number;
    lpGainUsd: number;                // LP value increase at that price
    netCombinedLossUsd: number;       // shortLoss - lpGain
    daysFeesToRecover: number;        // netCombinedLoss / dailyFeeUsd
  }[];

  capitalPreservationVerdict: "no-hedge" | "consider-hedge" | "hedge-recommended";
  capitalPreservationReason: string;
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

async function fetchDriftVolRatio(coinId: string): Promise<{ ratio: number; regime: string; pct7dChange: number }> {
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

  // 7-day price change from last 8 prices
  const last8 = prices.slice(-8);
  const pct7dChange = last8.length >= 2
    ? ((last8[last8.length - 1] - last8[0]) / last8[0]) * 100
    : 0;

  return { ratio, regime, pct7dChange };
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

/**
 * Capital preservation verdict — asks whether downside delta risk justifies hedge carry cost.
 *
 * Logic:
 *   - If a -20% HYPE move would cost >10× the 7-day hedge carry → hedge is cheap insurance → recommend
 *   - If hedge cost < daily IL accumulation rate → hedge is cheaper per day than the IL you're already taking → recommend
 *   - If 7d price trend is bearish (pct7d < -5%) AND notional > $500 → consider
 *   - Otherwise no-hedge
 */
function capitalPreservationVerdictFn(
  hypeNotionalUsd: number,
  dailyFundingCost: number,
  dailyIlRate: number,
  pct7dChange: number,
  downsideScenarios: HedgeReport["downsideScenarios"],
): { verdict: HedgeReport["capitalPreservationVerdict"]; reason: string } {
  const scenario20 = downsideScenarios.find((s) => s.dropPct === 0.20);
  const hedgeCarry7d = dailyFundingCost * 7;

  // Hedge is trivially cheap: 7-day carry covers less than 10% of a -20% scenario loss
  if (scenario20 && hedgeCarry7d > 0 && scenario20.deltaLossUsd / hedgeCarry7d > 10) {
    return {
      verdict: "hedge-recommended",
      reason:
        `A -20% HYPE drop would cost ${usdFmt(scenario20.deltaLossUsd)} vs ${usdFmt(hedgeCarry7d)} hedge carry over 7 days ` +
        `(${(scenario20.deltaLossUsd / hedgeCarry7d).toFixed(0)}× ratio). Hedge is cheap insurance for capital preservation.`,
    };
  }

  // Hedge costs less per day than IL is already accumulating
  if (dailyIlRate > 0 && dailyFundingCost < dailyIlRate) {
    return {
      verdict: "hedge-recommended",
      reason:
        `Daily hedge carry (${usdFmt(dailyFundingCost)}) < daily IL rate (${usdFmt(dailyIlRate)}). ` +
        `Hedge is cheaper per day than the divergence loss already accumulating.`,
    };
  }

  // Bearish 7d momentum + meaningful notional
  if (pct7dChange < -5 && hypeNotionalUsd > 500) {
    return {
      verdict: "consider-hedge",
      reason:
        `HYPE is down ${Math.abs(pct7dChange).toFixed(1)}% over 7 days with ${usdFmt(hypeNotionalUsd)} notional at risk. ` +
        `Consider a 50% delta short to limit downside without fully paying hedge carry.`,
    };
  }

  return {
    verdict: "no-hedge",
    reason:
      `Downside scenarios are within acceptable range relative to hedge carry cost. ` +
      `No capital preservation case for hedge at this time.`,
  };
}

// Formatting helper used inside verdict functions (defined early for reuse)
function usdFmt(n: number): string {
  return "$" + n.toFixed(2);
}

// ─── V3 Gamma helpers ────────────────────────────────────────────────────────

/**
 * Compute V3 liquidity constant L from current HYPE amount and price bounds.
 *   amount0 = L * (1/sqrt(P) - 1/sqrt(Pb))
 *   → L = amount0 / (1/sqrt(P) - 1/sqrt(Pb))
 */
function v3Liquidity(amount0: number, P: number, Pb: number): number {
  return amount0 / (1 / Math.sqrt(P) - 1 / Math.sqrt(Pb));
}

/**
 * Total USD value of the V3 LP position at a given price.
 *   In range:     value = HYPE_amount * P + USDC_amount
 *   Below lower:  all HYPE — value = hypeAtLower * P
 *   Above upper:  all USDC — value = L * (sqrt(Pb) - sqrt(Pa))
 */
function v3LpValue(L: number, P: number, Pa: number, Pb: number): number {
  const sqrtA = Math.sqrt(Pa);
  const sqrtB = Math.sqrt(Pb);
  if (P <= Pa) {
    const hype = L * (1 / sqrtA - 1 / sqrtB);
    return hype * P;
  }
  if (P >= Pb) {
    return L * (sqrtB - sqrtA);
  }
  const sqrtP = Math.sqrt(P);
  const hype = L * (1 / sqrtP - 1 / sqrtB);
  const usdc = L * (sqrtP - sqrtA);
  return hype * P + usdc;
}

/**
 * HYPE amount in LP at a given price (still in range: Pa < P < Pb).
 *   amount0 = L * (1/sqrt(P) - 1/sqrt(Pb))
 * Returns 0 if price is at or above upper bound.
 */
function v3HypeAtPrice(L: number, P: number, Pa: number, Pb: number): number {
  if (P >= Pb) return 0;
  if (P <= Pa) return L * (1 / Math.sqrt(Pa) - 1 / Math.sqrt(Pb));
  return L * (1 / Math.sqrt(P) - 1 / Math.sqrt(Pb));
}

/**
 * Recommended hedge size: largest short where the close trigger (price at which
 * 7-day fees+funding = total short loss) is at or above the LP entry price.
 *
 * Logic:
 *   close trigger = currentPrice + (dailyIncome7d / hedgeHype)
 *   We want: closeTrigger >= entryPrice
 *   → hedgeHype <= dailyIncome7d / (entryPrice - currentPrice)
 *
 * If entryPrice <= currentPrice (price has risen above entry), fall back to
 * 50% of current delta as a conservative floor.
 *
 * Also caps at 50% of lower-bound exposure to avoid over-hedging the gamma.
 */
function recommendedHedgeSize(
  hypeAtLower: number,
  currentHype: number,
  currentPrice: number,
  entryPrice: number,
  dailyFeeUsd: number,
  dailyFundingRate: number,
): { hype: number; reason: string } {
  const income7d = (dailyFeeUsd + currentHype * currentPrice * dailyFundingRate) * 7;
  const priceGapToEntry = entryPrice - currentPrice;

  let target: number;
  let reason: string;

  if (priceGapToEntry > 0) {
    // Size so that close trigger lands at LP entry price
    const maxByUpside = income7d / priceGapToEntry;
    const maxByGamma = hypeAtLower * 0.5;
    target = Math.min(maxByUpside, maxByGamma);
    reason =
      `Sized so close trigger falls at LP entry price ${usdFmt(entryPrice)} — the natural "thesis invalidated" level. ` +
      `Max by upside constraint: ${maxByUpside.toFixed(1)} HYPE. ` +
      `Max by gamma (50% of lower-bound exposure ${hypeAtLower.toFixed(1)} HYPE): ${maxByGamma.toFixed(1)} HYPE. ` +
      `Using the smaller: ${Math.round(target * 10) / 10} HYPE.`;
  } else {
    // Price already above entry — use conservative 30% of current delta
    target = currentHype * 0.3;
    reason =
      `Price is above LP entry — upside trend may be resuming. ` +
      `Conservative 30% of current delta (${currentHype.toFixed(1)} HYPE) = ${target.toFixed(1)} HYPE.`;
  }

  return {
    hype: Math.round(Math.max(target, 1) * 10) / 10,
    reason,
  };
}

/**
 * Hedge close trigger: price at which 7-day fees+funding = total short loss.
 * Beyond this price the short is draining more than income can recover in a week.
 * Also returns a reduce trigger at half that distance.
 */
function hedgeTriggers(
  currentPrice: number,
  recommendedHype: number,
  dailyFeeUsd: number,
  dailyFundingRate: number,
): { closePrice: number; reducePrice: number; reason: string } {
  const notional = recommendedHype * currentPrice;
  const dailyIncome = dailyFeeUsd + notional * dailyFundingRate;
  const income7d = dailyIncome * 7;
  // income7d = notional * movePct → movePct = income7d / notional
  const closeMovePct = income7d / notional;
  const closePrice = currentPrice * (1 + closeMovePct);
  const reducePrice = currentPrice * (1 + closeMovePct / 2);
  return {
    closePrice: Math.round(closePrice * 100) / 100,
    reducePrice: Math.round(reducePrice * 100) / 100,
    reason:
      `Close at ${usdFmt(closePrice)} (+${(closeMovePct * 100).toFixed(1)}% from current): ` +
      `7-day income (${usdFmt(income7d)}) equals total short loss at that price. ` +
      `Reduce to 50% at ${usdFmt(reducePrice)} (+${(closeMovePct / 2 * 100).toFixed(1)}%).`,
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

  const [fundingRate, { ratio: driftVolRatio, regime, pct7dChange }, openTs] = await Promise.all([
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

  // V3 liquidity constant and gamma-aware exposure bounds
  const liquidityConstant = v3Liquidity(hypeExposure, currentPrice, pos.priceUpper);
  const hypeExposureAtLowerBound = v3HypeAtPrice(liquidityConstant, pos.priceLower, pos.priceLower, pos.priceUpper);
  const hypeExposureAtUpperBound = 0; // all HYPE sold by the time price reaches upper bound

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

  // ── Capital preservation metrics ──────────────────────────────────────────
  // Daily IL rate: IL accumulated per day (not the same as fee run rate)
  const dailyIlRate = daysOpen && daysOpen > 0 ? ilUsd / daysOpen : 0;

  // Daily funding cost of a FULL delta hedge.
  // When funding is positive (longs pay shorts), a short position *earns* funding —
  // so the carry "cost" is actually negative (the hedge pays you).
  // We use dailyFundingEarned as the carry figure; it becomes the cost only if
  // funding flips negative (shorts pay longs). The capital preservation logic below
  // assumes positive funding; if annualizedFundingRate turns negative the hedge carry
  // flips sign and the recommendations should be treated as conservative.
  const dailyHedgeCost = dailyFundingEarned; // symmetric — earn funding while short (positive-funding assumption)

  const hedgeCostToIlRatio = dailyIlRate > 0 ? dailyHedgeCost / dailyIlRate : Infinity;

  // Downside scenarios: how much notional delta loss at -10%, -20%, -30%
  const SCENARIO_DROPS = [0.10, 0.20, 0.30];
  const downsideScenarios = SCENARIO_DROPS.map((dropPct) => ({
    dropPct,
    deltaLossUsd: hypeNotionalUsd * dropPct,
    hedgeCarryToDateUsd: dailyHedgeCost * 7, // 7-day carry as reference horizon
  }));

  // Upside scenarios: LP sheds HYPE as price rises — short becomes overhedged
  const { hype: recommendedHedgeHype, reason: recommendedHedgeReason } =
    recommendedHedgeSize(hypeExposureAtLowerBound, hypeExposure, currentPrice, pos.entryPrice, dailyFeeUsd ?? 0, dailyFundingRate);

  const SCENARIO_RISES = [0.05, 0.10, 0.15, 0.20];
  const currentLpValue = v3LpValue(liquidityConstant, currentPrice, pos.priceLower, pos.priceUpper);
  const upsideScenarios = SCENARIO_RISES.map((risePct) => {
    const newPrice = currentPrice * (1 + risePct);
    const lpHypeAtPrice = v3HypeAtPrice(liquidityConstant, newPrice, pos.priceLower, pos.priceUpper);
    const lpValueGainUsd = v3LpValue(liquidityConstant, newPrice, pos.priceLower, pos.priceUpper) - currentLpValue;
    const shortLossUsd = recommendedHedgeHype * currentPrice * risePct;
    const netCombinedUsd = shortLossUsd - lpValueGainUsd;
    const overhedgeHype = recommendedHedgeHype - lpHypeAtPrice;
    const fees7dUsd = (dailyFeeUsd ?? 0) * 7;
    const funding7dUsd = recommendedHedgeHype * currentPrice * dailyFundingRate * 7;
    const net7dUsd = fees7dUsd + funding7dUsd - shortLossUsd;
    return { risePct, newPrice, lpHypeAtPrice, lpValueGainUsd, shortLossUsd, netCombinedUsd, overhedgeHype, fees7dUsd, net7dUsd };
  });

  // ── Break-even hedge ──────────────────────────────────────────────────────
  // Size the short so its profit at the lower bound exactly covers the LP loss.
  //   shortProfit = priceDrop * hedgeSize
  //   lpLoss = currentLpValue - lpValueAtLower
  //   hedgeSize = lpLoss / priceDrop
  const lpValueAtLower = v3LpValue(liquidityConstant, pos.priceLower, pos.priceLower, pos.priceUpper);
  const lpLossAtLower = currentLpValue - lpValueAtLower;
  const priceDrop = currentPrice - pos.priceLower;
  const breakEvenSize = Math.round((lpLossAtLower / priceDrop) * 10) / 10;
  const breakEvenHedge = {
    sizeHype: breakEvenSize,
    notionalUsd: Math.round(breakEvenSize * currentPrice),
    lpLossAtLowerUsd: Math.round(lpLossAtLower * 100) / 100,
    lpValueAtLowerUsd: Math.round(lpValueAtLower * 100) / 100,
    verificationUsd: Math.round((lpValueAtLower + priceDrop * breakEvenSize) * 100) / 100,
  };

  // ── Stop loss scenarios ───────────────────────────────────────────────────
  // For each candidate stop price: short loss, LP value gain, net combined cost,
  // and days of fees needed to recover the net.
  const STOP_CANDIDATES = [59.52, 61.00, 61.58, 62.50, 65.00];
  const stopLossScenarios = STOP_CANDIDATES
    .filter((stop) => stop > currentPrice)
    .map((stopPrice) => {
      const shortLossUsd = (stopPrice - currentPrice) * breakEvenSize;
      const lpGainUsd = v3LpValue(liquidityConstant, stopPrice, pos.priceLower, pos.priceUpper) - currentLpValue;
      const netCombinedLossUsd = Math.round((shortLossUsd - lpGainUsd) * 100) / 100;
      const bufferPct = ((stopPrice - currentPrice) / currentPrice) * 100;
      const daysFeesToRecover = (dailyFeeUsd ?? 0) > 0 ? netCombinedLossUsd / (dailyFeeUsd ?? 1) : Infinity;
      return {
        stopPrice,
        bufferPct: Math.round(bufferPct * 10) / 10,
        shortLossUsd: Math.round(shortLossUsd * 100) / 100,
        lpGainUsd: Math.round(lpGainUsd * 100) / 100,
        netCombinedLossUsd,
        daysFeesToRecover: Math.round(daysFeesToRecover * 10) / 10,
      };
    });

  const { closePrice: hedgeCloseTriggerPrice, reducePrice: hedgeReduceTriggerPrice, reason: hedgeCloseTriggerReason } =
    hedgeTriggers(currentPrice, recommendedHedgeHype, dailyFeeUsd ?? 0, dailyFundingRate);

  const { verdict: capitalPreservationVerdict, reason: capitalPreservationReason } =
    capitalPreservationVerdictFn(
      hypeNotionalUsd,
      dailyHedgeCost,
      dailyIlRate,
      pct7dChange,
      downsideScenarios,
    );

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
    liquidityConstant,
    hypeExposureAtLowerBound,
    hypeExposureAtUpperBound,
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
    dailyIlRate,
    hedgeCostToIlRatio,
    downsideScenarios,
    upsideScenarios,
    recommendedHedgeHype,
    recommendedHedgeReason,
    hedgeCloseTriggerPrice,
    hedgeReduceTriggerPrice,
    hedgeCloseTriggerReason,
    breakEvenHedge,
    stopLossScenarios,
    capitalPreservationVerdict,
    capitalPreservationReason,
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

  console.log("\n### Delta Exposure (V3 gamma-aware)");
  console.log(
    `  ${perpSymbol} now:          ${report.hypeExposure.toFixed(2)} ${perpSymbol}  (${usd(report.hypeNotionalUsd)})`,
  );
  console.log(
    `  ${perpSymbol} at lower bound: ${report.hypeExposureAtLowerBound.toFixed(2)} ${perpSymbol}  (max exposure if price falls to ${usd(pos.priceLower)})`,
  );
  console.log(
    `  ${perpSymbol} at upper bound: 0.00 ${perpSymbol}  (LP fully converted to USDC at ${usd(pos.priceUpper)})`,
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

  console.log("\n### Capital Preservation");
  console.log(`  Daily IL rate:         ${usd(report.dailyIlRate)}/day`);
  console.log(`  Daily hedge carry:     ${usd(dailyHedgeCost)}/day`);
  console.log(
    `  Hedge cost / IL rate:  ${(report.hedgeCostToIlRatio * 100).toFixed(1)}%  ` +
      `(${report.hedgeCostToIlRatio < 1 ? "hedge cheaper than IL" : "hedge costs more than IL"})`,
  );

  console.log(`\n  Downside scenarios (full delta at current ${hypeExposure.toFixed(1)} HYPE):`);
  for (const s of report.downsideScenarios) {
    console.log(
      `    -${(s.dropPct * 100).toFixed(0)}%  →  delta loss ${usd(s.deltaLossUsd)}` +
        `  vs  7-day carry ${usd(s.hedgeCarryToDateUsd)}` +
        `  (${(s.deltaLossUsd / s.hedgeCarryToDateUsd).toFixed(0)}× ratio)`,
    );
  }

  console.log(`\n  Recommended hedge: ${report.recommendedHedgeHype} ${perpSymbol} short`);
  console.log(`  ${report.recommendedHedgeReason}`);

  console.log(`\n  Upside scenarios (recommended ${report.recommendedHedgeHype} ${perpSymbol} short):`);
  console.log(`  ${"rise".padEnd(6)}  ${"new price".padEnd(10)}  ${"LP HYPE".padEnd(9)}  ${"LP gain".padEnd(9)}  ${"short loss".padEnd(11)}  ${"net combined".padEnd(13)}  net (7d fees+funding-loss)`);
  for (const s of report.upsideScenarios) {
    console.log(
      `  +${(s.risePct * 100).toFixed(0)}%`.padEnd(7) +
      `  ${usd(s.newPrice).padEnd(10)}` +
      `  ${s.lpHypeAtPrice.toFixed(1).padEnd(9)}` +
      `  ${("+" + usd(s.lpValueGainUsd)).padEnd(9)}` +
      `  ${("-" + usd(s.shortLossUsd)).padEnd(11)}` +
      `  ${(s.netCombinedUsd >= 0 ? "-" : "+") + usd(Math.abs(s.netCombinedUsd)).padEnd(13)}` +
      `  ${s.net7dUsd >= 0 ? "+" : ""}${usd(s.net7dUsd)}`,
    );
  }

  console.log(`\n  Close trigger:  ${usd(report.hedgeCloseTriggerPrice)}`);
  console.log(`  Reduce trigger: ${usd(report.hedgeReduceTriggerPrice)}`);
  console.log(`  ${report.hedgeCloseTriggerReason}`);

  console.log("\n### Break-even Hedge");
  const be = report.breakEvenHedge;
  console.log(`  Size:              ${be.sizeHype} ${perpSymbol}  (${usd(be.notionalUsd)} notional)`);
  console.log(`  LP value now:      ${usd(currentLpValue)}`);
  console.log(`  LP value at lower: ${usd(be.lpValueAtLowerUsd)}`);
  console.log(`  LP loss at lower:  ${usd(be.lpLossAtLowerUsd)}`);
  console.log(`  Verification:      ${usd(be.verificationUsd)}  (LP + short profit at lower bound, should ≈ LP now)`);

  console.log(`\n  Stop loss scenarios (break-even size ${be.sizeHype} ${perpSymbol}):`);
  console.log(`  ${"stop".padEnd(8)}  ${"buffer".padEnd(8)}  ${"short loss".padEnd(11)}  ${"LP gain".padEnd(9)}  ${"net loss".padEnd(10)}  days fees`);
  for (const s of report.stopLossScenarios) {
    console.log(
      `  ${usd(s.stopPrice).padEnd(8)}` +
      `  +${s.bufferPct.toFixed(1)}%`.padEnd(9) +
      `  ${("-" + usd(s.shortLossUsd)).padEnd(11)}` +
      `  ${("+" + usd(s.lpGainUsd)).padEnd(9)}` +
      `  ${("-" + usd(s.netCombinedLossUsd)).padEnd(10)}` +
      `  ${s.daysFeesToRecover.toFixed(1)} days`,
    );
  }

  console.log("\n### Verdict (fee-optimisation)");
  const icons = { "no-hedge": "✗", "consider-hedge": "△", "hedge-recommended": "✓" };
  console.log(`  ${icons[verdict]}  ${verdict.toUpperCase()}`);
  console.log(`  ${verdictReason}`);

  console.log("\n### Verdict (capital preservation)");
  console.log(`  ${icons[report.capitalPreservationVerdict]}  ${report.capitalPreservationVerdict.toUpperCase()}`);
  console.log(`  ${report.capitalPreservationReason}`);
  console.log();
}

main().catch((err: Error) => {
  console.error("Error:", err.message);
  process.exit(1);
});
