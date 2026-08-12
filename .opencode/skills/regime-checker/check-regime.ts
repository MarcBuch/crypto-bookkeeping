#!/usr/bin/env bun
/**
 * check-regime.ts — WHYPE/USDC market regime detector.
 *
 * Fetches 30+ days of daily price data from Hyperliquid candleSnapshot and
 * computes the drift/vol ratio as defined in PLAYBOOK.md:
 *
 *   dailyDrift = total log return / N
 *   dailyVol   = std dev of N daily log returns
 *   ratio      = abs(dailyDrift) / dailyVol
 *
 * Regime table (from playbook):
 *   ratio < 0.5   → Range-bound  → Full position, normal rerange discipline
 *   0.5 – 1.0     → Mild trend   → Reduce position 50%, widen range
 *   > 1.0         → Strong trend → Pause LP entirely, hold HYPE
 *
 * Usage:
 *   bun .opencode/skills/regime-checker/check-regime.ts [--json]
 *   bun .opencode/skills/regime-checker/check-regime.ts [TICKER] [--json]
 *
 * Examples:
 *   bun check-regime.ts
 *   bun check-regime.ts --json
 *   bun check-regime.ts HYPE --json
 */

const coin =
  process.argv.find(
    (a) =>
      !a.startsWith("--") &&
      !a.includes("check-regime") &&
      !a.includes("bun") &&
      !a.endsWith(".ts"),
  ) ?? "HYPE";

const jsonMode = process.argv.includes("--json");
const HL_API = "https://api.hyperliquid.xyz/info";

// ─── Types ─────────────────────────────────────────────────────────────────────

type Regime = "range-bound" | "mild-trend" | "strong-trend";

interface HlCandle {
  t: number; // open time ms
  T: number; // close time ms
  s: string; // symbol
  i: string; // interval
  o: string; // open
  c: string; // close
  h: string; // high
  l: string; // low
  v: string; // volume
  n: number; // number of trades
}

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
  signedRatio: number;
  direction: "uptrend" | "downtrend" | "flat";
  regime: Regime;
  action: string;
  positionGuidance: string;
  rerangeGuidance: string;
  openInterest: number; // USD

  // 7-day window
  priceChange7d: number; // percent
  dailyDrift7d: number;
  dailyVol7d: number;
  ratio7d: number;
  signedRatio7d: number;
  direction7d: "uptrend" | "downtrend" | "flat";
  regime7d: Regime;
  windowsDiverge: boolean; // true when 30d and 7d regimes disagree
  windowDivergenceInterpretation: string | null;
}

// ─── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchCandles(
  ticker: string,
): Promise<{ prices: number[]; timestamps: number[] }> {
  // Request 35 days back to ensure we always get at least 32 candles
  const now = Date.now();
  const startTime = now - 35 * 24 * 60 * 60 * 1000;

  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: {
        coin: ticker,
        interval: "1d",
        startTime,
        endTime: now,
      },
    }),
  });
  if (!res.ok)
    throw new Error(`Hyperliquid API error: ${res.status} ${res.statusText}`);
  const candles = (await res.json()) as HlCandle[];
  if (candles.length < 2)
    throw new Error(`Insufficient candle data for ${ticker} from Hyperliquid`);
  // Sort ascending by open time, take the 32 most-recent candles
  const sorted = [...candles].sort((a, b) => a.t - b.t).slice(-32);
  return {
    prices: sorted.map((candle) => parseFloat(candle.c)),
    timestamps: sorted.map((candle) => candle.t),
  };
}

async function fetchOpenInterest(ticker: string): Promise<number> {
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  if (!res.ok)
    throw new Error(`Hyperliquid API error: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as [
    { universe: { name: string }[] },
    { openInterest: string; funding: string; markPx: string }[],
  ];
  const idx = data[0].universe.findIndex((a) => a.name === ticker);
  if (idx === -1) throw new Error(`Coin ${ticker} not found in Hyperliquid`);
  return parseFloat(data[1][idx].openInterest);
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

function classifyDirection(
  dailyDrift: number,
  flatThreshold = 0.0015,
): "uptrend" | "downtrend" | "flat" {
  if (dailyDrift > flatThreshold) return "uptrend";
  if (dailyDrift < -flatThreshold) return "downtrend";
  return "flat";
}

function signedDriftVolRatio(dailyDrift: number, dailyVol: number): number {
  return dailyVol > 0 ? dailyDrift / dailyVol : 0;
}

function divergenceInterpretation(
  direction30d: "uptrend" | "downtrend" | "flat",
  direction7d: "uptrend" | "downtrend" | "flat",
  regime30d: Regime,
  regime7d: Regime,
): string {
  if (direction30d === direction7d) {
    return `Same direction, but ${regime7d} is the nearer-term read.`;
  }
  if (direction30d === "flat") {
    return `30d is flat while 7d is ${direction7d}; short-term momentum is emerging.`;
  }
  if (direction7d === "flat") {
    return `7d is flat while 30d is ${direction30d}; recent momentum has cooled.`;
  }
  return `30d is ${direction30d} while 7d flipped to ${direction7d}; near-term bias has reversed.`;
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
  const maxRatio = 2.0;
  const filled = Math.round(Math.min(ratio / maxRatio, 1) * width);
  const b = "█".repeat(filled) + "░".repeat(width - filled);
  return `[${b}]  0──0.5──1.0──2.0`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [{ prices, timestamps }, openInterest] = await Promise.all([
    fetchCandles(coin),
    fetchOpenInterest(coin),
  ]);

  if (prices.length < 2) {
    throw new Error("Insufficient price data returned from Hyperliquid");
  }

  // 32 prices → 31 log returns
  const returns = logReturns(prices);
  const dailyDrift = mean(returns);
  const dailyVol = stddev(returns);
  const ratio = dailyVol > 0 ? Math.abs(dailyDrift) / dailyVol : 0;
  const signedRatio = signedDriftVolRatio(dailyDrift, dailyVol);
  const direction = classifyDirection(dailyDrift);
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
  const signedRatio7d = signedDriftVolRatio(dailyDrift7d, dailyVol7d);
  const direction7d = classifyDirection(dailyDrift7d);
  const regime7d = classify(ratio7d);
  const priceChange7d =
    ((prices7d[prices7d.length - 1] - prices7d[0]) / prices7d[0]) * 100;
  const windowsDiverge = regime !== regime7d;
  const windowDivergenceInterpretation = windowsDiverge
    ? divergenceInterpretation(direction, direction7d, regime, regime7d)
    : null;

  const report: RegimeReport = {
    coin,
    symbol: coin,
    fetchedAt: new Date().toISOString(),
    days: returns.length,
    currentPrice,
    priceChange30d,
    dailyReturns: returns,
    dailyDrift,
    dailyVol,
    ratio,
    signedRatio,
    direction,
    regime,
    action: REGIME_ACTIONS[regime],
    positionGuidance: REGIME_ACTIONS[regime],
    rerangeGuidance: RERANGE_GUIDANCE[regime],
    openInterest,
    priceChange7d,
    dailyDrift7d,
    dailyVol7d,
    ratio7d,
    signedRatio7d,
    direction7d,
    regime7d,
    windowsDiverge,
    windowDivergenceInterpretation,
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

  console.log(`\n## Regime Check: ${coin}`);
  console.log(
    `Window: ${report.days} trading days  (${startDate} → ${endDate})\n`,
  );

  console.log("### Price Summary");
  console.log(`  Current:    $${currentPrice.toFixed(2)}`);
  console.log(`  30d change: ${fmtPct(priceChange30d / 100)}`);
  console.log(`  7d change:  ${fmtPct(priceChange7d / 100)}`);

  console.log("\n### Regime Metrics");
  console.log(`  Window        drift       vol         ratio    signed   direction`);
  console.log(
    `  30d (${returns.length} days)  ${fmtPct(dailyDrift).padEnd(10)}  ${fmtPct(dailyVol, false).padEnd(10)}  ${ratio.toFixed(3).padEnd(7)}  ${signedRatio.toFixed(3).padEnd(7)}  ${direction}`,
  );
  console.log(
    `  7d  (7 days)   ${fmtPct(dailyDrift7d).padEnd(10)}  ${fmtPct(dailyVol7d, false).padEnd(10)}  ${ratio7d.toFixed(3).padEnd(7)}  ${signedRatio7d.toFixed(3).padEnd(7)}  ${direction7d}`,
  );
  console.log(`\n  30d bar: ${bar(ratio)}`);
  console.log(`  7d  bar: ${bar(ratio7d)}`);

  if (windowsDiverge) {
    console.log(
      `\n  ** DIVERGENCE: 30d is ${REGIME_LABELS[regime].toUpperCase()} but 7d is ${REGIME_LABELS[regime7d].toUpperCase()} **`,
    );
    console.log(`  ${windowDivergenceInterpretation}`);
  }

  console.log("\n### Regime (30d — primary)");
  console.log(
    `  ${REGIME_LABELS[regime].toUpperCase()}  (ratio = ${ratio.toFixed(3)}, signed = ${signedRatio.toFixed(3)}, direction = ${direction})`,
  );

  console.log("\n### Regime (7d — near-term)");
  console.log(
    `  ${REGIME_LABELS[regime7d].toUpperCase()}  (ratio = ${ratio7d.toFixed(3)}, signed = ${signedRatio7d.toFixed(3)}, direction = ${direction7d})`,
  );

  console.log("\n### Market Context");
  console.log(
    `  Open interest: $${openInterest.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
  );

  console.log("\n### Playbook Action");
  if (windowsDiverge) {
    console.log(`  Based on 30d: ${REGIME_ACTIONS[regime]}`);
    console.log(`  Based on 7d:  ${REGIME_ACTIONS[regime7d]}`);
    console.log(`  Interpretation: ${windowDivergenceInterpretation}`);
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

export {};
