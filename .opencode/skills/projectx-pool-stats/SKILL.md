---
name: projectx-pool-stats
description: Use when the user wants current or historical ProjectX APR, TVL, volume, fees, fee slowdown, or active boost campaigns. Also use when comparing fee tiers, checking Merkl boosts, diagnosing why advertised yield changed, or assessing whether pool APR justifies staying in or reranging.
---

# Skill: ProjectX Pool Stats

Fetches ProjectX pool data from two sources:

- ProjectX DEX API (`https://api.prjx.com`) for live headline APR and Merkl boosts
- Goldsky Uniswap V3 HyperEVM subgraph for historical fee APR, TVL, volume, and slowdown diagnostics

Live ProjectX data includes:

- Current APR — base fee APR + active Merkl boost APR
- TVL, 24h volume, 24h fee revenue
- Boost campaign details (reward token, daily USD, end date)
- Break-even rerange days for HYPE/USDC pools (contextualised to LP position size)

Goldsky history includes:

- Daily fee APR from historical `feesUSD` / `tvlUSD`
- Rolling hourly fee APR for recent slowdown checks
- Volume-vs-TVL decomposition, e.g. volume down vs liquidity up
- Fee-only data; Merkl boost APR is not included

## When to use

- User asks "what is the current APR on ProjectX?"
- User wants to check if the APR has changed since they opened their position
- User asks about active boost rewards or Merkl campaigns
- User wants to compare fee tiers (0.05% vs 0.30% for HYPE/USDC)
- User asks whether reranging is worth it at current pool APR
- User wants TVL or volume context before deciding to enter or exit
- User asks why advertised ProjectX APR/yield dropped or whether fees slowed down
- User wants recent daily/hourly fee APR history for a pool

## How to Run

```bash
SKILL_DIR=$(git rev-parse --show-toplevel)/.opencode/skills/projectx-pool-stats

# Default: HYPE/USDC pools (0.05% and 0.30% fee tiers)
bun "$SKILL_DIR/pool-stats.ts" 2>/dev/null

# Search by pool name
bun "$SKILL_DIR/pool-stats.ts" HYPE/USDC 2>/dev/null

# Filter by fee tier (basis points: 100=0.01%, 500=0.05%, 3000=0.30%)
bun "$SKILL_DIR/pool-stats.ts" HYPE/USDC --fee 500 2>/dev/null

# Top 20 pools by TVL
bun "$SKILL_DIR/pool-stats.ts" --all 2>/dev/null

# JSON output (for agent/programmatic use)
bun "$SKILL_DIR/pool-stats.ts" --json 2>/dev/null
bun "$SKILL_DIR/pool-stats.ts" HYPE/USDC --fee 500 --json 2>/dev/null

# Historical fee APR / slowdown analysis from Goldsky
bun "$SKILL_DIR/pool-history.ts" HYPE/USDC --fee 500 2>/dev/null
bun "$SKILL_DIR/pool-history.ts" HYPE/USDC --fee 500 --days 14 --hours 48 --json 2>/dev/null
bun "$SKILL_DIR/pool-history.ts" --pool 0x6c9a33e3b592c0d65b3ba59355d5be0d38259285 --json 2>/dev/null
```

## Live JSON Output Schema (`pool-stats.ts`)

```json
{
  "fetchedAt": "2026-06-13T20:51:00.000Z",
  "pools": [
    {
      "id": "0x6c9a33e3b592c0d65b3ba59355d5be0d38259285",
      "name": "HYPE/USDC",
      "feeTier": "500",            // basis points — 500 = 0.05%
      "tvlUSD": "14819156.25",
      "volume24h": "74922240.14",
      "fee24h": "37461.12",
      "apr": "96.51",             // total APR (base + boost) as %
      "baseApr": "92.27",         // fee-only APR as %
      "isBoosted": true,
      "boost": {
        "merklApr": "4.24",       // Merkl reward APR as %
        "dailyRewardsUSD": "1564.52",
        "rewardTokens": [{ "symbol": "USDC" }],
        "endsAt": 1782144000      // unix timestamp
      },
      "token0": { "symbol": "WHYPE", "tokenPriceUSD": "59.83" },
      "token1": { "symbol": "USDC", "tokenPriceUSD": "1" }
    }
  ]
}
```

## History JSON Output Schema (`pool-history.ts`)

```json
{
  "fetchedAt": "2026-07-05T15:20:00.000Z",
  "source": "goldsky-uniswap-v3-hyperevm-position",
  "pool": {
    "id": "0x6c9a33e3b592c0d65b3ba59355d5be0d38259285",
    "feeTier": "500",
    "feeRatePct": 0.05,
    "tvlUSD": 15230451,
    "token0": { "symbol": "WHYPE" },
    "token1": { "symbol": "USDC" },
    "token1Price": 69.72
  },
  "summary": {
    "averageDaily": {
      "avgDailyVolumeUSD": 68852557,
      "avgDailyFeesUSD": 34426,
      "feeAprPct": 84.6
    },
    "rollingHours": {
      "totalVolumeUSD": 35003230,
      "totalFeesUSD": 17502,
      "dailyizedVolumeUSD": 35003230,
      "dailyizedFeesUSD": 17502,
      "annualizedFeeAprPct": 41.8
    },
    "slowdown": {
      "verdict": "volume-down",
      "volumeVsAveragePct": -49.2,
      "feesVsAveragePct": -49.2,
      "tvlVsAveragePct": 5.1,
      "aprVsAveragePct": -50.6
    }
  },
  "days": [{ "date": "2026-07-04", "volumeUSD": 47781849, "feesUSD": 23891, "feeAprPct": 56.1 }],
  "hours": [{ "hour": "2026-07-05T14:00:00.000Z", "feesUSD": 608.53, "annualizedFeeAprPct": 35.1 }]
}
```

## Key Notes

- `pool-stats.ts` returns a single live snapshot from ProjectX, including Merkl boosts.
- `pool-history.ts` returns historical fee-only APR from Goldsky; it excludes Merkl boosts.
- Use `pool-history.ts` when diagnosing fee slowdowns or advertised APR compression over time.
- `apr` = `baseApr` + Merkl boost. Use `baseApr` for fee income projections; the boost is campaign-dependent and has an end date.
- The break-even rerange line in human output is computed against a fixed $2,449 position size — scale the numbers proportionally for different sizes.
- All numeric fields from the API come back as strings; the script parses them with `parseFloat`.
- The `--fee` flag takes basis points (`500` for 0.05%, `3000` for 0.30%).
- For HYPE/USDC, Goldsky `token0Price` is inverted HYPE per USDC; prefer `token1Price` for USDC per HYPE.

Base directory for this skill: /Users/marc.buchardt/fun/private/bookkeeping/.opencode/skills/projectx-pool-stats
