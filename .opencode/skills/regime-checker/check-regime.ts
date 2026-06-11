#!/usr/bin/env bun
/**
 * check-regime.ts — WHYPE/USDC market regime detector.
 *
 * Fetches 30 days of daily HYPE price data from CoinGecko and computes
 * the drift/vol ratio as defined in PLAYBOOK.md:
 *
 *   dailyDrift = total log return / 30
 *   dailyVol   = std dev of 30 daily log returns
 *   ratio      = dailyDrift / dailyVol
 *
 * Regime table (from playbook):
 *   ratio < 0.5   → Range-bound  → Full position, normal rerange discipline
 *   0.5 – 1.0     → Mild trend   → Reduce position 50%, widen range
 *   > 1.0         → Strong trend → Pause LP entirely, hold HYPE
 *
 * Usage:
 *   bun .opencode/skills/regime-checker/check-regime.ts [--json]
 *   bun .opencode/skills/regime-checker/check-regime.ts [coin_id] [--json]
 *
 * Examples:
 *   bun check-regime.ts
 *   bun check-regime.ts --json
 *   bun check-regime.ts hyperliquid --json
 */

const coinId =
  process.argv.find(
    (a) =>
      !a.startsWith("--") &&
      !a.includes("check-regime") &&
      !a.includes("bun") &&
      !a.endsWith(".ts"),
  ) ?? "hyperliquid";

const jsonMode = process.argv.includes("--json");
const COINGECKO_API = "https://api.coingecko.com/api/v3";

// ─── Types ─────────────────────────────────────────────────────────────────────

type Regime = "range-bound" | "mild-trend" | "strong-trend";

interface RegimeReport {
  coin: string;
  symbol: string;
  fetchedAt: string;
  days: number;
  currentPrice: number;
  priceChange30d: number; // percent
  dailyReturns: number[];
  dailyDrift: number;
  dailyVol: number;
  ratio: number;
  regime: Regime;
  action: string;
  positionGuidance: string;
  rerangeGuidance: string;

  // 7-day window
  priceChange7d: number;  // percent
  dailyDrift7d: number;
  dailyVol7d: number;
  ratio7d: number;
  regime7d: Regime;
  windowsDiverge: boolean; // true when 30d and 7d regimes disagree
}

// ─── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchPrices(
  id: string,
  days = 31,
): Promise<{ prices: number[]; timestamps: number[] }> {
  // interval=daily gives one point per day; fetch 31 to get 30 log returns
  const url = `${COINGECKO_API}/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko error: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { prices: [number, number][] };
  return {
    prices: data.prices.map(([, p]) => p),
    timestamps: data.prices.map(([t]) => t),
  };
}

async function fetchSymbol(id: string): Promise<string> {
  const url = `${COINGECKO_API}/coins/${id}?localization=false&tickers=false&market_data=false`;
  const res = await fetch(url);
  if (!res.ok) return id.toUpperCase();
  const data = (await res.json()) as { symbol?: string };
  return (data.symbol ?? id).toUpperCase();
}

// ─── Maths ─────────────────────────────────────────────────────────────────────

function logReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }
  return returns;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

// ─── Classification ────────────────────────────────────────────────────────────

function classify(ratio: number): Regime {
  if (ratio < 0.5) return "range-bound";
  if (ratio <= 1.0) return "mild-trend";
  return "strong-trend";
}

const REGIME_LABELS: Record<Regime, string> = {
  "range-bound": "Range-bound",
  "mild-trend": "Mild trend",
  "strong-trend": "Strong trend",
};

const REGIME_ACTIONS: Record<Regime, string> = {
  "range-bound":
    "Full position. Normal rerange discipline (outer-third trigger).",
  "mild-trend":
    "Reduce position size 50%. Widen range. Monitor drift/vol weekly.",
  "strong-trend":
    "PAUSE LP ENTIRELY. Close position, hold HYPE spot. AMM sells into every pump — no fee rate compensates.",
};

const RERANGE_GUIDANCE: Record<Regime, string> = {
  "range-bound":
    "Rerange on outer-third trigger at standard ±15–17% width. Every cycle >5 days is profitable.",
  "mild-trend":
    "If you rerange, use a wider range (±20–25%) to reduce rerange frequency. Consider asymmetric range biased in trend direction.",
  "strong-trend":
    "Do not rerange. Close the LP. The opportunity cost of the LP selling your HYPE into a pump exceeds any fee income.",
};

// ─── Formatting ────────────────────────────────────────────────────────────────

function fmtPct(n: number, signed = true): string {
  const s = (n * 100).toFixed(2) + "%";
  return signed && n > 0 ? "+" + s : s;
}

function bar(ratio: number, width = 30): string {
  const thresholds = [0, 0.5, 1.0, 2.0];
  const maxRatio = 2.0;
  const filled = Math.round(Math.min(ratio / maxRatio, 1) * width);
  const b = "█".repeat(filled) + "░".repeat(width - filled);
  return `[${b}]  0──0.5──1.0──2.0`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [{ prices, timestamps }, symbol] = await Promise.all([
    fetchPrices(coinId, 31),
    fetchSymbol(coinId),
  ]);

  if (prices.length < 2) {
    throw new Error("Insufficient price data returned from CoinGecko");
  }

  const returns = logReturns(prices);
  const dailyDrift = mean(returns);
  const dailyVol = stddev(returns);
  const ratio = dailyVol > 0 ? Math.abs(dailyDrift) / dailyVol : 0;
  const regime = classify(ratio);

  const currentPrice = prices[prices.length - 1];
  const oldPrice = prices[0];
  const priceChange30d = ((currentPrice - oldPrice) / oldPrice) * 100;

  // ── 7-day window (last 8 prices → 7 log returns) ──────────────────────────
  const prices7d = prices.slice(-8);
  const returns7d = logReturns(prices7d);
  const dailyDrift7d = mean(returns7d);
  const dailyVol7d = stddev(returns7d);
  const ratio7d = dailyVol7d > 0 ? Math.abs(dailyDrift7d) / dailyVol7d : 0;
  const regime7d = classify(ratio7d);
  const priceChange7d = ((prices7d[prices7d.length - 1] - prices7d[0]) / prices7d[0]) * 100;
  const windowsDiverge = regime !== regime7d;

  const report: RegimeReport = {
    coin: coinId,
    symbol,
    fetchedAt: new Date().toISOString(),
    days: returns.length,
    currentPrice,
    priceChange30d,
    dailyReturns: returns,
    dailyDrift,
    dailyVol,
    ratio,
    regime,
    action: REGIME_ACTIONS[regime],
    positionGuidance: REGIME_ACTIONS[regime],
    rerangeGuidance: RERANGE_GUIDANCE[regime],
    priceChange7d,
    dailyDrift7d,
    dailyVol7d,
    ratio7d,
    regime7d,
    windowsDiverge,
  };

  if (jsonMode) {
    // Omit dailyReturns from JSON (verbose, rarely needed by agent)
    const { dailyReturns: _, ...out } = report;
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // ── Human-readable output ──────────────────────────────────────────────────
  const startDate = new Date(timestamps[0]).toISOString().split("T")[0];
  const endDate = new Date(timestamps[timestamps.length - 1])
    .toISOString()
    .split("T")[0];

  console.log(`\n## Regime Check: ${symbol} (${coinId})`);
  console.log(
    `Window: ${report.days} trading days  (${startDate} → ${endDate})\n`,
  );

  console.log("### Price Summary");
  console.log(`  Current:    $${currentPrice.toFixed(2)}`);
  console.log(`  30d change: ${fmtPct(priceChange30d / 100)}`);
  console.log(`  7d change:  ${fmtPct(priceChange7d / 100)}`);

  console.log("\n### Regime Metrics");
  console.log(`  Window        drift       vol         ratio    regime`);
  console.log(
    `  30d (${returns.length} days)  ${fmtPct(dailyDrift).padEnd(10)}  ${fmtPct(dailyVol, false).padEnd(10)}  ${ratio.toFixed(3).padEnd(7)}  ${REGIME_LABELS[regime]}`,
  );
  console.log(
    `  7d  (7 days)   ${fmtPct(dailyDrift7d).padEnd(10)}  ${fmtPct(dailyVol7d, false).padEnd(10)}  ${ratio7d.toFixed(3).padEnd(7)}  ${REGIME_LABELS[regime7d]}`,
  );
  console.log(`\n  30d bar: ${bar(ratio)}`);
  console.log(`  7d  bar: ${bar(ratio7d)}`);

  if (windowsDiverge) {
    console.log(
      `\n  ** DIVERGENCE: 30d is ${REGIME_LABELS[regime].toUpperCase()} but 7d is ${REGIME_LABELS[regime7d].toUpperCase()} **`,
    );
    console.log(
      `  The short-term regime is shifting. Use the 7d reading to inform near-term decisions.`,
    );
  }

  console.log("\n### Regime (30d — primary)");
  console.log(`  ${REGIME_LABELS[regime].toUpperCase()}  (ratio = ${ratio.toFixed(3)})`);

  console.log("\n### Regime (7d — near-term)");
  console.log(`  ${REGIME_LABELS[regime7d].toUpperCase()}  (ratio = ${ratio7d.toFixed(3)})`);

  console.log("\n### Playbook Action");
  if (windowsDiverge) {
    console.log(`  Based on 30d: ${REGIME_ACTIONS[regime]}`);
    console.log(`  Based on 7d:  ${REGIME_ACTIONS[regime7d]}`);
  } else {
    console.log(`  ${REGIME_ACTIONS[regime]}`);
  }

  console.log("\n### Rerange Guidance");
  console.log(`  ${RERANGE_GUIDANCE[regime]}`);

  console.log();
}

main().catch((err: Error) => {
  console.error("Error:", err.message);
  process.exit(1);
});
