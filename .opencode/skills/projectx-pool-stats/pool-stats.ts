#!/usr/bin/env bun
/**
 * pool-stats.ts — Fetch live pool stats from ProjectX (prjx.com).
 *
 * Calls the public ProjectX API to retrieve:
 *   - Current APR (base fee APR + any active Merkl boost)
 *   - 24h volume and fee revenue
 *   - TVL and liquidity
 *   - Active boost campaign details (rewards, end date)
 *
 * Usage:
 *   bun pool-stats.ts                         # active LP pools from config
 *   bun pool-stats.ts HYPE/USDC               # search by name
 *   bun pool-stats.ts HYPE/USDC --fee 500     # filter by fee tier (bps)
 *   bun pool-stats.ts --all                   # top 20 pools by TVL
 *   bun pool-stats.ts --json                  # machine-readable output
 *
 * Examples:
 *   bun pool-stats.ts HYPE/USDC --fee 500
 *   bun pool-stats.ts --all --json 2>/dev/null
 */

import { execSync } from "child_process";
import * as path from "path";

// HyperEVM RPC uses a custom CA — disable TLS verification (same pattern as other skills)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const PRJX_API = "https://api.prjx.com";

const jsonMode = process.argv.includes("--json");
const allMode = process.argv.includes("--all");

const feeArgIdx = process.argv.indexOf("--fee");
const feeTierFilter = feeArgIdx !== -1 ? process.argv[feeArgIdx + 1] : null;

const searchArg = process.argv.find(
  (a) =>
    !a.startsWith("--") &&
    !a.includes("pool-stats") &&
    !a.includes("bun") &&
    !a.endsWith(".ts"),
);

// ─── Types ───────────────────────────────────────────────────────────────────

interface BoostCampaign {
  opportunityId: string;
  merklApr: string | number;  // API returns string
  dailyRewardsUSD: string | number;
  liveCampaigns: number;
  rewardTokens: { address: string; symbol: string; icon: string }[];
  endsAt: number;             // unix timestamp
}

interface PoolToken {
  address: string;
  symbol: string;
  name: string;
  decimals: string;
  logoURI: string;
  tokenPriceUSD: string;
}

interface Pool {
  id: string;
  name: string;
  feeTier: string;
  liquidity: string;
  version: string;
  tvlUSD: string | number;
  volume24h: string | number;
  fee24h: string | number;
  apr: string | number;
  baseApr: string | number;
  isBoosted: boolean;
  boost: BoostCampaign | null;
  createdAtTimestamp: number;
  fetchedAtTimestamp: number;
  token0: PoolToken;
  token1: PoolToken;
}

interface PoolsResponse {
  pools: Pool[];
  totalCount: number;
  limit: number;
  offset: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function repoRoot(): string {
  return execSync("git rev-parse --show-toplevel").toString().trim();
}

function readConfig(): {
  poolAddresses: string[];
  wallet: string;
} {
  try {
    const root = repoRoot();
    const raw = require("fs").readFileSync(path.join(root, "config.json"), "utf8");
    const cfg = JSON.parse(raw);
    const wallet: string = cfg.wallet ?? "";
    // Derive pool addresses from known contract addresses in lp positions
    // We use the factory pools that match our active LP positions' token pairs
    const poolAddresses: string[] = [];
    return { poolAddresses, wallet };
  } catch {
    return { poolAddresses: [], wallet: "" };
  }
}

async function fetchPools(params: {
  search?: string;
  feeTier?: string;
  limit?: number;
  offset?: number;
}): Promise<PoolsResponse> {
  const qs = new URLSearchParams();
  if (params.search) qs.set("search", params.search);
  if (params.feeTier) qs.set("feeTier", params.feeTier);
  qs.set("limit", String(params.limit ?? 20));
  if (params.offset) qs.set("offset", String(params.offset));

  const url = `${PRJX_API}/pools?${qs.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ProjectX API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<PoolsResponse>;
}

function n(v: string | number): number { return parseFloat(String(v)); }

function formatApr(apr: string | number): string {
  return n(apr).toFixed(2) + "%";
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}

function feePct(tier: string): string {
  return (parseInt(tier) / 10000).toFixed(2) + "%";
}

function boostEndsIn(endsAt: number): string {
  const secs = endsAt - Date.now() / 1000;
  if (secs <= 0) return "expired";
  const days = Math.floor(secs / 86400);
  return `${days}d`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Determine what to fetch
  let pools: Pool[] = [];

  if (allMode) {
    // Top 20 by TVL (default sort from API)
    const data = await fetchPools({ limit: 20 });
    pools = data.pools;
  } else if (searchArg) {
    // Search by name + optional fee tier filter — deduplicate by id
    const data = await fetchPools({
      search: searchArg,
      feeTier: feeTierFilter ?? undefined,
      limit: 10,
    });
    const seen = new Set<string>();
    for (const p of data.pools) {
      if (!seen.has(p.id)) { seen.add(p.id); pools.push(p); }
    }
  } else {
    // Default: fetch HYPE/USDC (the active LP pair) at both fee tiers
    const [low, mid] = await Promise.all([
      fetchPools({ search: "HYPE/USDC", feeTier: "500", limit: 5 }),
      fetchPools({ search: "HYPE/USDC", feeTier: "3000", limit: 5 }),
    ]);
    // Deduplicate by pool id
    const seen = new Set<string>();
    for (const p of [...low.pools, ...mid.pools]) {
      if (!seen.has(p.id)) { seen.add(p.id); pools.push(p); }
    }
  }

  if (pools.length === 0) {
    const msg = "No pools found" + (searchArg ? ` for "${searchArg}"` : "");
    if (jsonMode) { console.log(JSON.stringify({ pools: [], error: msg })); }
    else { console.log(msg); }
    return;
  }

  if (jsonMode) {
    console.log(JSON.stringify({ pools, fetchedAt: new Date().toISOString() }, null, 2));
    return;
  }

  // ── Human-readable ────────────────────────────────────────────────────────
  console.log(`\n## ProjectX Pool Stats`);
  console.log(`Fetched: ${new Date().toUTCString()}\n`);

  for (const p of pools) {
    const merklApr = p.boost ? parseFloat(String(p.boost.merklApr)) : 0;
    const dailyRewardsUSD = p.boost ? parseFloat(String(p.boost.dailyRewardsUSD)) : 0;
    const boostNote = p.boost
      ? ` + ${merklApr.toFixed(2)}% Merkl (${boostEndsIn(p.boost.endsAt)} left)`
      : "";

    console.log(`### ${p.name}  (${feePct(p.feeTier)} fee tier)`);
    console.log(`  Pool:     ${p.id}`);
    console.log(`  APR:      ${formatApr(p.baseApr)} base${boostNote}  →  total ${formatApr(p.apr)}`);
    console.log(`  TVL:      ${formatUsd(n(p.tvlUSD))}`);
    console.log(`  24h vol:  ${formatUsd(n(p.volume24h))}`);
    console.log(`  24h fees: ${formatUsd(n(p.fee24h))}`);

    if (p.boost) {
      console.log(`  Boost:    ${formatUsd(dailyRewardsUSD)}/day in ${p.boost.rewardTokens.map((t) => t.symbol).join(", ")}  (ends ${new Date(p.boost.endsAt * 1000).toISOString().split("T")[0]})`);
    }

    // Break-even rerange check — only for HYPE/USDC pools
    if (p.name === "HYPE/USDC") {
      const entryValue = 2449;
      const dailyFee = (n(p.apr) / 100) * entryValue / 365;
      const dlCost = entryValue * 0.02;
      const breakEvenDays = dlCost / dailyFee;
      const expectedDays = 8.5;
      const profitPerCycle = dailyFee * expectedDays - dlCost;
      console.log(`  Rerange:  break-even ${breakEvenDays.toFixed(1)} days  |  expected profit/cycle $${profitPerCycle.toFixed(0)}  (at $${entryValue} position)`);
    }

    console.log();
  }
}

main().catch((err: Error) => {
  console.error("Error:", err.message);
  process.exit(1);
});
