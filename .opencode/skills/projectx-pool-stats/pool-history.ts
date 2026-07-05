#!/usr/bin/env bun
/**
 * pool-history.ts — Fetch historical ProjectX pool fee data from Goldsky.
 *
 * Uses the public Goldsky Uniswap V3 HyperEVM subgraph to retrieve pool day/hour
 * data, then derives fee APR and slowdown diagnostics from volume, fees, and TVL.
 * Merkl boosts are not included here; use pool-stats.ts for live boost APR.
 *
 * Usage:
 *   bun pool-history.ts                                      # HYPE/USDC 0.05%, 7d + 24h
 *   bun pool-history.ts HYPE/USDC --fee 500 --days 14 --hours 48
 *   bun pool-history.ts --pool 0x6c9a...9285 --json
 */

const GOLDKSY_ENDPOINT =
  "https://api.goldsky.com/api/public/project_cmbbm2iwckb1b01t39xed236t/subgraphs/uniswap-v3-hyperevm-position/prod/gn";
const PRJX_API = "https://api.prjx.com";

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");

function option(name: string): string | null {
  const idx = args.indexOf(name);
  return idx === -1 ? null : (args[idx + 1] ?? null);
}

function positionalArgs(): string[] {
  const values: string[] = [];
  const optionsWithValues = new Set(["--pool", "--fee", "--days", "--hours"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (optionsWithValues.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("--") || arg.endsWith(".ts")) continue;
    values.push(arg);
  }
  return values;
}

const poolArg = option("--pool")?.toLowerCase() ?? null;
const feeTierArg = option("--fee") ?? "500";
const daysArg = parsePositiveInt(option("--days"), 7);
const hoursArg = parsePositiveInt(option("--hours"), 24);
const searchArg = positionalArgs()[0] ?? "HYPE/USDC";

interface ProjectXPool {
  id: string;
  name: string;
  feeTier: string;
  version: string;
}

interface TokenRef {
  id: string;
  symbol: string;
  decimals: string;
}

interface GoldskyPoolRow {
  tvlUSD: string;
  volumeUSD: string;
  feesUSD?: string;
  txCount?: string;
  token0Price?: string;
  token1Price?: string;
  low?: string;
  high?: string;
  close?: string;
}

interface GoldskyDayRow extends GoldskyPoolRow {
  date: number;
}

interface GoldskyHourRow extends GoldskyPoolRow {
  periodStartUnix: number;
  tick?: string;
  feeGrowthGlobal0X128?: string;
  feeGrowthGlobal1X128?: string;
}

interface GoldskyPool {
  id: string;
  feeTier: string;
  totalValueLockedUSD: string;
  liquidity: string;
  tick: string | null;
  token0Price: string;
  token1Price: string;
  token0: TokenRef;
  token1: TokenRef;
  poolDayData: GoldskyDayRow[];
  poolHourData: GoldskyHourRow[];
}

interface NormalizedDay {
  date: string;
  tvlUSD: number;
  volumeUSD: number;
  feesUSD: number;
  feeAprPct: number;
  txCount: number | null;
  token1Price: number | null;
}

interface NormalizedHour {
  hour: string;
  tvlUSD: number;
  volumeUSD: number;
  feesUSD: number;
  annualizedFeeAprPct: number;
  txCount: number | null;
  token1Price: number | null;
}

const POOL_HISTORY_QUERY = `
query PoolFeeHistory($pool: String!, $days: Int!, $periodStart: Int!) {
  pool(id: $pool) {
    id
    feeTier
    totalValueLockedUSD
    liquidity
    tick
    token0Price
    token1Price
    token0 { id symbol decimals }
    token1 { id symbol decimals }
    poolDayData(first: $days, orderBy: date, orderDirection: desc) {
      date
      tvlUSD
      volumeUSD
      feesUSD
      txCount
      token0Price
      token1Price
      low
      high
      close
    }
    poolHourData(
      first: 200
      orderBy: periodStartUnix
      orderDirection: asc
      where: { periodStartUnix_gte: $periodStart }
    ) {
      periodStartUnix
      tvlUSD
      volumeUSD
      feesUSD
      txCount
      token0Price
      token1Price
      low
      high
      close
      tick
      feeGrowthGlobal0X128
      feeGrowthGlobal1X128
    }
  }
}`;

async function main() {
  const poolId = poolArg ?? (await resolvePoolId(searchArg, feeTierArg));
  const periodStart = Math.floor(Date.now() / 1000) - hoursArg * 3600;
  const pool = await fetchGoldskyPool(poolId, daysArg, periodStart);
  const feeRate = parseInt(pool.feeTier, 10) / 1_000_000;
  const days = pool.poolDayData.map((row) => normalizeDay(row, feeRate));
  const hours = pool.poolHourData.map((row) => normalizeHour(row, feeRate));
  const recentHours = hours.slice(-hoursArg);
  const completeDays = days.filter((day) => isCompleteUtcDay(day.date));
  const avgWindow = completeDays.length > 0 ? completeDays : days;
  const sevenDay = summarizeDays(avgWindow);
  const rolling = summarizeHours(recentHours);
  const currentDay = days[0] ?? null;
  const slowdown = classifySlowdown({ sevenDay, rolling });
  const output = {
    fetchedAt: new Date().toISOString(),
    source: "goldsky-uniswap-v3-hyperevm-position",
    pool: {
      id: pool.id,
      feeTier: pool.feeTier,
      feeRatePct: feeRate * 100,
      tvlUSD: n(pool.totalValueLockedUSD),
      liquidity: pool.liquidity,
      tick: pool.tick,
      token0Price: n(pool.token0Price),
      token1Price: n(pool.token1Price),
      token0: pool.token0,
      token1: pool.token1,
    },
    summary: {
      daysRequested: daysArg,
      hoursRequested: hoursArg,
      dayRows: days.length,
      hourRows: hours.length,
      currentPartialDay: currentDay,
      averageDaily: sevenDay,
      rollingHours: rolling,
      slowdown,
    },
    days,
    hours,
  };

  if (jsonMode) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  printHuman(output);
}

async function resolvePoolId(search: string, feeTier: string): Promise<string> {
  const qs = new URLSearchParams({ search, feeTier, limit: "20" });
  const res = await fetch(`${PRJX_API}/pools?${qs.toString()}`);
  if (!res.ok) throw new Error(`ProjectX API error ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as { pools?: ProjectXPool[] };
  const pools = data.pools ?? [];
  const exact = pools.find(
    (pool) => pool.name.toLowerCase() === search.toLowerCase() && pool.version === "V3",
  );
  const fallback = pools.find((pool) => pool.version === "V3") ?? pools[0];
  if (!exact && !fallback) throw new Error(`No ProjectX pool found for ${search} fee ${feeTier}`);
  return (exact ?? fallback).id.toLowerCase();
}

async function fetchGoldskyPool(pool: string, days: number, periodStart: number): Promise<GoldskyPool> {
  const res = await fetch(GOLDKSY_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: POOL_HISTORY_QUERY,
      variables: { pool: pool.toLowerCase(), days, periodStart },
    }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`Goldsky error ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
  }
  if (!json.data?.pool) throw new Error(`Goldsky returned no pool for ${pool}`);
  return json.data.pool as GoldskyPool;
}

function normalizeDay(row: GoldskyDayRow, feeRate: number): NormalizedDay {
  const tvlUSD = n(row.tvlUSD);
  const volumeUSD = n(row.volumeUSD);
  const feesUSD = feeUsd(row, feeRate);
  return {
    date: new Date(row.date * 1000).toISOString().slice(0, 10),
    tvlUSD,
    volumeUSD,
    feesUSD,
    feeAprPct: apr(feesUSD, tvlUSD, 365),
    txCount: row.txCount == null ? null : n(row.txCount),
    token1Price: row.token1Price == null ? null : n(row.token1Price),
  };
}

function normalizeHour(row: GoldskyHourRow, feeRate: number): NormalizedHour {
  const tvlUSD = n(row.tvlUSD);
  const volumeUSD = n(row.volumeUSD);
  const feesUSD = feeUsd(row, feeRate);
  return {
    hour: new Date(row.periodStartUnix * 1000).toISOString(),
    tvlUSD,
    volumeUSD,
    feesUSD,
    annualizedFeeAprPct: apr(feesUSD, tvlUSD, 24 * 365),
    txCount: row.txCount == null ? null : n(row.txCount),
    token1Price: row.token1Price == null ? null : n(row.token1Price),
  };
}

function summarizeDays(days: NormalizedDay[]) {
  const count = days.length;
  const totalVolumeUSD = sum(days, "volumeUSD");
  const totalFeesUSD = sum(days, "feesUSD");
  const avgTvlUSD = avg(days.map((day) => day.tvlUSD));
  const avgDailyVolumeUSD = count === 0 ? 0 : totalVolumeUSD / count;
  const avgDailyFeesUSD = count === 0 ? 0 : totalFeesUSD / count;
  return {
    window: `${count} complete day${count === 1 ? "" : "s"}`,
    avgTvlUSD,
    avgDailyVolumeUSD,
    avgDailyFeesUSD,
    feeAprPct: apr(avgDailyFeesUSD, avgTvlUSD, 365),
  };
}

function summarizeHours(hours: NormalizedHour[]) {
  const count = hours.length;
  const totalVolumeUSD = sum(hours, "volumeUSD");
  const totalFeesUSD = sum(hours, "feesUSD");
  const dailyizedVolumeUSD = count === 0 ? 0 : (totalVolumeUSD * 24) / count;
  const dailyizedFeesUSD = count === 0 ? 0 : (totalFeesUSD * 24) / count;
  const avgTvlUSD = avg(hours.map((hour) => hour.tvlUSD));
  const annualizedFeeAprPct = count === 0 ? 0 : apr(totalFeesUSD, avgTvlUSD, (24 / count) * 365);
  return {
    window: `${count} hour${count === 1 ? "" : "s"}`,
    avgTvlUSD,
    totalVolumeUSD,
    totalFeesUSD,
    dailyizedVolumeUSD,
    dailyizedFeesUSD,
    annualizedFeeAprPct,
  };
}

function classifySlowdown(params: {
  sevenDay: ReturnType<typeof summarizeDays>;
  rolling: ReturnType<typeof summarizeHours>;
}) {
  const volumeRatio = safeRatio(params.rolling.dailyizedVolumeUSD, params.sevenDay.avgDailyVolumeUSD);
  const feeRatio = safeRatio(params.rolling.dailyizedFeesUSD, params.sevenDay.avgDailyFeesUSD);
  const tvlRatio = safeRatio(params.rolling.avgTvlUSD, params.sevenDay.avgTvlUSD);
  const aprRatio = safeRatio(params.rolling.annualizedFeeAprPct, params.sevenDay.feeAprPct);
  const drivers: string[] = [];

  if (volumeRatio < 0.75) drivers.push("volume-down");
  if (tvlRatio > 1.05) drivers.push("tvl-up");
  if (drivers.length === 0 && aprRatio < 0.85) drivers.push("mixed");
  if (drivers.length === 0) drivers.push("no-material-slowdown");

  return {
    verdict: drivers.join("+"),
    volumeVsAveragePct: pctChange(volumeRatio),
    feesVsAveragePct: pctChange(feeRatio),
    tvlVsAveragePct: pctChange(tvlRatio),
    aprVsAveragePct: pctChange(aprRatio),
  };
}

function printHuman(output: Awaited<ReturnType<typeof buildOutputShape>>) {
  console.log("\n## ProjectX Goldsky Pool History");
  console.log(`Fetched: ${new Date(output.fetchedAt).toUTCString()}\n`);
  console.log(`Pool: ${output.pool.token0.symbol}/${output.pool.token1.symbol} ${feePct(output.pool.feeTier)} (${output.pool.id})`);
  console.log(`Current TVL: ${formatUsd(output.pool.tvlUSD)}`);
  console.log(`Current price (${output.pool.token1.symbol}/${output.pool.token0.symbol}): ${output.pool.token1Price.toFixed(2)}\n`);

  console.log("### Summary");
  console.log(`  Avg daily fees (${output.summary.averageDaily.window}): ${formatUsd(output.summary.averageDaily.avgDailyFeesUSD)}`);
  console.log(`  Avg daily volume: ${formatUsd(output.summary.averageDaily.avgDailyVolumeUSD)}`);
  console.log(`  Avg fee APR: ${formatPct(output.summary.averageDaily.feeAprPct)}`);
  console.log(`  Rolling ${output.summary.rollingHours.window} fees: ${formatUsd(output.summary.rollingHours.totalFeesUSD)}`);
  console.log(`  Rolling fee APR: ${formatPct(output.summary.rollingHours.annualizedFeeAprPct)}`);
  console.log(`  Slowdown: ${output.summary.slowdown.verdict}`);
  console.log(`  APR vs avg: ${formatSignedPct(output.summary.slowdown.aprVsAveragePct)}\n`);

  console.log("### Daily Fee APR");
  for (const day of output.days) {
    console.log(
      `  ${day.date}  TVL ${formatUsd(day.tvlUSD).padStart(8)}  Vol ${formatUsd(day.volumeUSD).padStart(8)}  Fees ${formatUsd(day.feesUSD).padStart(8)}  APR ${formatPct(day.feeAprPct).padStart(7)}`,
    );
  }
  console.log();
}

function buildOutputShape() {
  return Promise.resolve({
    fetchedAt: "",
    pool: {
      id: "",
      feeTier: "",
      feeRatePct: 0,
      tvlUSD: 0,
      liquidity: "",
      tick: "" as string | null,
      token0Price: 0,
      token1Price: 0,
      token0: { id: "", symbol: "", decimals: "" },
      token1: { id: "", symbol: "", decimals: "" },
    },
    summary: {
      daysRequested: 0,
      hoursRequested: 0,
      dayRows: 0,
      hourRows: 0,
      currentPartialDay: null as NormalizedDay | null,
      averageDaily: summarizeDays([]),
      rollingHours: summarizeHours([]),
      slowdown: classifySlowdown({ sevenDay: summarizeDays([]), rolling: summarizeHours([]) }),
    },
    days: [] as NormalizedDay[],
    hours: [] as NormalizedHour[],
  });
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = value == null ? NaN : parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function feeUsd(row: GoldskyPoolRow, feeRate: number): number {
  const fees = row.feesUSD == null ? NaN : n(row.feesUSD);
  return Number.isFinite(fees) && fees > 0 ? fees : n(row.volumeUSD) * feeRate;
}

function apr(feesUSD: number, tvlUSD: number, periodsPerYear: number): number {
  return tvlUSD > 0 ? (feesUSD * periodsPerYear * 100) / tvlUSD : 0;
}

function n(value: string | number): number {
  return Number(value);
}

function sum<T, K extends keyof T>(rows: T[], key: K): number {
  return rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
}

function avg(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function safeRatio(current: number, baseline: number): number {
  return baseline === 0 ? 0 : current / baseline;
}

function pctChange(ratio: number): number {
  return (ratio - 1) * 100;
}

function isCompleteUtcDay(date: string): boolean {
  return date !== new Date().toISOString().slice(0, 10);
}

function feePct(tier: string): string {
  return `${(parseInt(tier, 10) / 10_000).toFixed(2)}%`;
}

function formatUsd(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatSignedPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

main().catch((err: Error) => {
  console.error("Error:", err.message);
  process.exit(1);
});
