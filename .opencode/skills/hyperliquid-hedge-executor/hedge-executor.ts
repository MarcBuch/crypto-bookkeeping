#!/usr/bin/env bun

type Candle = {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
};

type Level = { price: number; size: number };

type MarketPlan = {
  kind: "rebound" | "breakdown";
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  sizeHype: number;
  notionalUsd: number;
  riskUsd: number;
  reward1Usd: number;
  reward2Usd: number;
  rr1: number;
  rr2: number;
  note: string;
};

type HedgeExecutionReport = {
  symbol: string;
  sizeHype: number;
  fetchedAt: string;
  live: {
    mark: number;
    mid: number;
    bestBid: number;
    bestAsk: number;
    spreadUsd: number;
    spreadBps: number;
    depthBidUsd: number;
    depthAskUsd: number;
    imbalance: number;
    shortEntryFillAvg: number;
    shortEntrySlippageBps: number;
    shortEntryUnfilledHype: number;
  };
  funding: {
    currentHourly: number;
    predictedHourly: number;
    predictedSource: string;
    predictedNote: string;
    currentAnnualizedProxy: number;
    historyCount: number;
    historyAvgHourly: number | null;
    historyMinHourly: number | null;
    historyMaxHourly: number | null;
    historyPositiveShare: number | null;
    historyLastHourly: number | null;
    historyNote: string;
  };
  openInterest: {
    currentUsd: number;
    currentHype: number;
    snapshotOnly: boolean;
    shortWindowChangeUsd: number | null;
    note: string;
  };
  candles: {
    interval: "1h" | "4h";
    count: number;
    currentClose: number;
    vwap20: number;
    atr14: number;
    momentum5Pct: number;
    momentum20Pct: number;
    swingSupport: number;
    swingResistance: number;
    supportDistancePct: number;
    resistanceDistancePct: number;
  }[];
  plans: MarketPlan[];
  warnings: string[];
};

const HL_API = "https://api.hyperliquid.xyz/info";

const argv = process.argv.slice(2);
const symbol = parseSymbol(argv);
const sizeHype = parseSize(argv, 4.2);
const jsonMode = process.argv.includes("--json");

function parseSymbol(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--size") {
      i++;
      continue;
    }
    if (a.startsWith("--")) continue;
    return a.toUpperCase();
  }
  return "HYPE";
}

function parseSize(args: string[], fallback: number): number {
  const idx = args.indexOf("--size");
  if (idx >= 0 && idx + 1 < args.length) {
    const n = Number.parseFloat(args[idx + 1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

function n(v: unknown): number {
  const x = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(x) ? x : NaN;
}

function round(v: number, d = 2): number {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function pct(v: number, d = 2): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

async function postInfo<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid API error: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

function normalizeLevels(raw: unknown): Level[] {
  const items = Array.isArray(raw) ? raw : [];
  return items
    .map((item) => {
      if (Array.isArray(item) && item.length >= 2) {
        const price = n(item[0]);
        const size = n(item[1]);
        return Number.isFinite(price) && Number.isFinite(size) ? { price, size } : null;
      }
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const price = n(obj.px ?? obj.price ?? obj.p);
        const size = n(obj.sz ?? obj.size ?? obj.s);
        return Number.isFinite(price) && Number.isFinite(size) ? { price, size } : null;
      }
      return null;
    })
    .filter((x): x is Level => x !== null);
}

function bookMid(bestBid: number, bestAsk: number): number {
  return (bestBid + bestAsk) / 2;
}

function cumulativeNotional(levels: Level[], limit: number): number {
  return levels.slice(0, limit).reduce((sum, level) => sum + level.price * level.size, 0);
}

function simulateMarketSell(levels: Level[], size: number): { avgFill: number; unfilled: number } {
  let remaining = size;
  let notional = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    notional += take * level.price;
    remaining -= take;
  }
  const filled = size - remaining;
  return { avgFill: filled > 0 ? notional / filled : NaN, unfilled: remaining };
}

function vwap(candles: Candle[], count = 20): number {
  const slice = candles.slice(-count);
  const num = slice.reduce((sum, c) => sum + ((n(c.h) + n(c.l) + n(c.c)) / 3) * n(c.v), 0);
  const den = slice.reduce((sum, c) => sum + n(c.v), 0);
  return den > 0 ? num / den : NaN;
}

function atr(candles: Candle[], count = 14): number {
  const slice = candles.slice(-(count + 1));
  if (slice.length < count + 1) return NaN;
  const trs: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const high = n(slice[i].h);
    const low = n(slice[i].l);
    const prevClose = n(slice[i - 1].c);
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function momentumPct(candles: Candle[], periods: number): number {
  if (candles.length <= periods) return NaN;
  const latest = n(candles[candles.length - 1].c);
  const prior = n(candles[candles.length - 1 - periods].c);
  return ((latest / prior) - 1) * 100;
}

function swingLevels(candles: Candle[], current: number): { support: number; resistance: number } {
  const slice = candles.slice(-40);
  const lows: number[] = [];
  const highs: number[] = [];
  for (let i = 2; i < slice.length - 2; i++) {
    const low = n(slice[i].l);
    const high = n(slice[i].h);
    if (low < n(slice[i - 1].l) && low <= n(slice[i + 1].l) && low <= n(slice[i + 2].l)) lows.push(low);
    if (high > n(slice[i - 1].h) && high >= n(slice[i + 1].h) && high >= n(slice[i + 2].h)) highs.push(high);
  }
  const supportCandidates = lows.filter((x) => x < current).sort((a, b) => b - a);
  const resistanceCandidates = highs.filter((x) => x > current).sort((a, b) => a - b);
  return {
    support: supportCandidates[0] ?? Math.min(...slice.map((c) => n(c.l))),
    resistance: resistanceCandidates[0] ?? Math.max(...slice.map((c) => n(c.h))),
  };
}

async function fetchMeta(symbol: string): Promise<{ mark: number; fundingHourly: number; openInterest: number }> {
  const data = await postInfo<any>({ type: "metaAndAssetCtxs" });
  const universe = data?.[0]?.universe ?? [];
  const idx = universe.findIndex((u: { name: string }) => u.name === symbol);
  if (idx < 0) throw new Error(`Symbol not found: ${symbol}`);
  const ctx = data?.[1]?.[idx] ?? {};
  return {
    mark: n(ctx.markPx),
    fundingHourly: n(ctx.funding),
    openInterest: n(ctx.openInterest),
  };
}

async function fetchPredictedFunding(symbol: string): Promise<{ predictedHourly: number; source: string; note: string }> {
  try {
    const data = await postInfo<any>({ type: "predictedFundings" });
    const coinEntry = (Array.isArray(data) ? data : []).find((entry: any) => Array.isArray(entry) && entry[0] === symbol);
    const hlPerpEntry = Array.isArray(coinEntry?.[1])
      ? coinEntry[1].find((entry: any) => Array.isArray(entry) && entry[0] === "HlPerp")
      : null;
    const predictedHourly = n(hlPerpEntry?.[1]?.fundingRate);
    if (Number.isFinite(predictedHourly)) {
      return {
        predictedHourly,
        source: "predictedFundings.HlPerp",
        note: "Public predicted funding for Hyperliquid perpetuals from the info endpoint.",
      };
    }
  } catch {
    // fall through to current funding rate
  }
  return {
    predictedHourly: NaN,
    source: "currentFundingRateFallback",
    note: "Predicted funding was unavailable; fell back to current hourly funding rate.",
  };
}

async function fetchBook(symbol: string): Promise<{ bids: Level[]; asks: Level[] }> {
  const data = await postInfo<any>({ type: "l2Book", coin: symbol });
  const rawBids = data?.levels?.[0] ?? data?.bids ?? data?.[0] ?? [];
  const rawAsks = data?.levels?.[1] ?? data?.asks ?? data?.[1] ?? [];
  const bids = normalizeLevels(rawBids).sort((a, b) => b.price - a.price);
  const asks = normalizeLevels(rawAsks).sort((a, b) => a.price - b.price);
  if (!bids.length || !asks.length) throw new Error(`No order book levels for ${symbol}`);
  return { bids, asks };
}

async function fetchCandles(symbol: string, interval: "1h" | "4h", daysBack: number): Promise<Candle[]> {
  const now = Date.now();
  const startTime = now - daysBack * 24 * 60 * 60 * 1000;
  const data = await postInfo<any>({ type: "candleSnapshot", req: { coin: symbol, interval, startTime, endTime: now } });
  const candles = (Array.isArray(data) ? data : data?.candles ?? data?.data ?? []) as Candle[];
  return [...candles].sort((a, b) => a.t - b.t);
}

async function fetchFundingHistory(symbol: string): Promise<{ time: number; funding: number }[]> {
  try {
    const now = Date.now();
    const data = await postInfo<any>({ type: "fundingHistory", coin: symbol, startTime: now - 7 * 24 * 60 * 60 * 1000, endTime: now });
    const items = Array.isArray(data) ? data : data?.fundingHistory ?? data?.data ?? [];
    return items
      .map((x: any) => ({ time: n(x.time ?? x.t ?? x.ts), funding: n(x.funding ?? x.fundingRate ?? x.rate) }))
      .filter((x: { time: number; funding: number }) => Number.isFinite(x.time) && Number.isFinite(x.funding));
  } catch {
    return [];
  }
}

function summarizeFunding(history: { time: number; funding: number }[]): {
  avg: number | null;
  min: number | null;
  max: number | null;
  positiveShare: number | null;
  last: number | null;
  note: string;
} {
  if (!history.length) {
    return { avg: null, min: null, max: null, positiveShare: null, last: null, note: "Funding history unavailable from public snapshot." };
  }
  const vals = history.map((x) => x.funding);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const positiveShare = vals.filter((x) => x > 0).length / vals.length;
  return {
    avg,
    min: Math.min(...vals),
    max: Math.max(...vals),
    positiveShare,
    last: vals[vals.length - 1],
    note: `History window: ${history.length} samples from public funding history.`,
  };
}

function buildPlan(kind: "rebound" | "breakdown", current: number, atr14: number, support: number, resistance: number, sizeHype: number): MarketPlan {
  const atrBuffer = Math.max(atr14 * 0.75, current * 0.0035);
  const entry = kind === "rebound" ? resistance * 0.999 : support * 0.999;
  const stop = kind === "rebound" ? resistance + atrBuffer : support + atrBuffer;
  const target1 = kind === "rebound" ? current : support - atr14 * 0.75;
  const target2 = kind === "rebound" ? support : support - atr14 * 1.5;
  const notionalUsd = sizeHype * entry;
  const riskUsd = sizeHype * Math.max(stop - entry, 0);
  const reward1Usd = sizeHype * Math.max(entry - target1, 0);
  const reward2Usd = sizeHype * Math.max(entry - target2, 0);
  return {
    kind,
    entry: round(entry, 2),
    stop: round(stop, 2),
    target1: round(target1, 2),
    target2: round(target2, 2),
    sizeHype: round(sizeHype, 4),
    notionalUsd: round(notionalUsd, 2),
    riskUsd: round(riskUsd, 2),
    reward1Usd: round(reward1Usd, 2),
    reward2Usd: round(reward2Usd, 2),
    rr1: riskUsd > 0 ? round(reward1Usd / riskUsd, 2) : NaN,
    rr2: riskUsd > 0 ? round(reward2Usd / riskUsd, 2) : NaN,
    note: kind === "rebound"
      ? "Limit-sell/short only if price re-tests resistance and fails; keep an OCO-style stop and target bracket if actually executed."
      : "Stop-sell/short only on a clean support break; use a bracket order if the venue supports it, otherwise manage manually.",
  };
}

async function main() {
  const [meta, book, candles1h, candles4h, fundingHistory] = await Promise.all([
    fetchMeta(symbol),
    fetchBook(symbol),
    fetchCandles(symbol, "1h", 14),
    fetchCandles(symbol, "4h", 60),
    fetchFundingHistory(symbol),
  ]);

  const bestBid = book.bids[0].price;
  const bestAsk = book.asks[0].price;
  const mid = bookMid(bestBid, bestAsk);
  const spreadUsd = bestAsk - bestBid;
  const spreadBps = (spreadUsd / mid) * 10000;
  const depthBidUsd = cumulativeNotional(book.bids, 5);
  const depthAskUsd = cumulativeNotional(book.asks, 5);
  const imbalance = (depthBidUsd + depthAskUsd) > 0 ? depthBidUsd / (depthBidUsd + depthAskUsd) : NaN;
  const shortFill = simulateMarketSell(book.bids, sizeHype);
  const shortEntryFillAvg = shortFill.avgFill;
  const shortEntrySlippageBps = Number.isFinite(shortEntryFillAvg) ? ((mid - shortEntryFillAvg) / mid) * 10000 : NaN;

  const historySummary = summarizeFunding(fundingHistory);
  const fundingHourly = meta.fundingHourly;
  const predictedFunding = symbol === "HYPE"
    ? await fetchPredictedFunding(symbol)
    : { predictedHourly: fundingHourly, source: "currentFundingRateFallback", note: "Predicted funding only fetched for HYPE; fell back to current hourly funding rate." };

  const candleStats = ([{ interval: "1h", candles: candles1h }, { interval: "4h", candles: candles4h }] as const).map(({ interval, candles }) => {
    const currentClose = n(candles[candles.length - 1].c);
    const sr = swingLevels(candles, currentClose);
    return {
      interval,
      count: candles.length,
      currentClose: round(currentClose, 4),
      vwap20: round(vwap(candles), 4),
      atr14: round(atr(candles), 4),
      momentum5Pct: round(momentumPct(candles, 5), 2),
      momentum20Pct: round(momentumPct(candles, 20), 2),
      swingSupport: round(sr.support, 4),
      swingResistance: round(sr.resistance, 4),
      supportDistancePct: round(((currentClose - sr.support) / currentClose) * 100, 2),
      resistanceDistancePct: round(((sr.resistance - currentClose) / currentClose) * 100, 2),
    };
  });

  const current4h = candleStats.find((x) => x.interval === "4h")!;
  const support = current4h.swingSupport;
  const resistance = current4h.swingResistance;
  const plans = [
    buildPlan("rebound", mid, current4h.atr14, support, resistance, sizeHype),
    buildPlan("breakdown", mid, current4h.atr14, support, resistance, sizeHype),
  ];

  const report: HedgeExecutionReport = {
    symbol,
    sizeHype: round(sizeHype, 4),
    fetchedAt: new Date().toISOString(),
    live: {
      mark: round(meta.mark, 4),
      mid: round(mid, 4),
      bestBid: round(bestBid, 4),
      bestAsk: round(bestAsk, 4),
      spreadUsd: round(spreadUsd, 4),
      spreadBps: round(spreadBps, 2),
      depthBidUsd: round(depthBidUsd, 2),
      depthAskUsd: round(depthAskUsd, 2),
      imbalance: round(imbalance, 4),
      shortEntryFillAvg: round(shortEntryFillAvg, 4),
      shortEntrySlippageBps: round(shortEntrySlippageBps, 2),
      shortEntryUnfilledHype: round(shortFill.unfilled, 6),
    },
    funding: {
      currentHourly: round(fundingHourly, 8),
      predictedHourly: round(Number.isFinite(predictedFunding.predictedHourly) ? predictedFunding.predictedHourly : fundingHourly, 8),
      predictedSource: predictedFunding.source,
      predictedNote: predictedFunding.note,
      currentAnnualizedProxy: round(fundingHourly * 24 * 365, 6),
      historyCount: fundingHistory.length,
      historyAvgHourly: historySummary.avg == null ? null : round(historySummary.avg, 8),
      historyMinHourly: historySummary.min == null ? null : round(historySummary.min, 8),
      historyMaxHourly: historySummary.max == null ? null : round(historySummary.max, 8),
      historyPositiveShare: historySummary.positiveShare == null ? null : round(historySummary.positiveShare, 4),
      historyLastHourly: historySummary.last == null ? null : round(historySummary.last, 8),
      historyNote: historySummary.note,
    },
    openInterest: {
      currentUsd: round(meta.openInterest * meta.mark, 2),
      currentHype: round(meta.openInterest, 6),
      snapshotOnly: true,
      shortWindowChangeUsd: null,
      note: "Snapshot only; openInterest is in HYPE coin units from the meta asset context, so USD is computed as openInterest * mark. No delayed re-sample taken in this read-only skill, so short-window OI change is intentionally omitted.",
    },
    candles: candleStats,
    plans,
    warnings: [
      "Read-only analysis only; no account, wallet, or order calls were made.",
      "Use an OCO/bracket structure if you later execute manually; this skill does not submit orders.",
      shortFill.unfilled > 0 ? "Requested size exceeds visible top-of-book depth; slippage may be worse than the estimate." : "Estimated slippage is based on visible bid depth only.",
    ],
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n## Hyperliquid Hedge Execution: ${symbol}`);
  console.log(`Size: ${report.sizeHype} HYPE | Fetched: ${report.fetchedAt}`);
  console.log(`Live mark/mid: ${fmtUsd(report.live.mark)} / ${fmtUsd(report.live.mid)} | spread ${fmtUsd(report.live.spreadUsd)} (${report.live.spreadBps.toFixed(2)} bps)`);
  console.log(`Top-5 depth: bid ${fmtUsd(report.live.depthBidUsd)} | ask ${fmtUsd(report.live.depthAskUsd)} | imbalance ${(report.live.imbalance * 100).toFixed(1)}% bids`);
  console.log(`Short-entry estimate: avg fill ${fmtUsd(report.live.shortEntryFillAvg)} | slippage ${report.live.shortEntrySlippageBps.toFixed(2)} bps | unfilled ${report.live.shortEntryUnfilledHype.toFixed(4)} HYPE`);
  console.log(`Funding: current ${pct(report.funding.currentHourly, 4)} hourly | predicted ${pct(report.funding.predictedHourly, 4)} (${report.funding.predictedSource}) | hist avg ${report.funding.historyAvgHourly == null ? "n/a" : pct(report.funding.historyAvgHourly, 4)}`);
  for (const c of report.candles) {
    console.log(`\n${c.interval} candles: close ${fmtUsd(c.currentClose)} | VWAP20 ${fmtUsd(c.vwap20)} | ATR14 ${fmtUsd(c.atr14)} | mom5 ${pct(c.momentum5Pct)} | mom20 ${pct(c.momentum20Pct)}`);
    console.log(`  Swing support/resistance: ${fmtUsd(c.swingSupport)} / ${fmtUsd(c.swingResistance)} | distance ${c.supportDistancePct.toFixed(1)}% / ${c.resistanceDistancePct.toFixed(1)}%`);
  }
  console.log(`\nOpen interest: ${fmtUsd(report.openInterest.currentUsd)} USD (${report.openInterest.currentHype} HYPE) | ${report.openInterest.note}`);
  for (const plan of report.plans) {
    console.log(`\n${plan.kind.toUpperCase()} candidate: entry ${fmtUsd(plan.entry)} stop ${fmtUsd(plan.stop)} target1 ${fmtUsd(plan.target1)} target2 ${fmtUsd(plan.target2)}`);
    console.log(`  size ${plan.sizeHype} HYPE | notional ${fmtUsd(plan.notionalUsd)} | risk ${fmtUsd(plan.riskUsd)} | R/R ${plan.rr1.toFixed(2)} / ${plan.rr2.toFixed(2)}`);
    console.log(`  ${plan.note}`);
  }
  console.log(`\nWarnings: ${report.warnings.join(" ")}`);
}

main().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

export {};
