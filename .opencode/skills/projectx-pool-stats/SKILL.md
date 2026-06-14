---
name: projectx-pool-stats
description: Use when the user wants to check the current APR, TVL, 24h volume, fees, or active boost campaigns on ProjectX (prjx.com). Also use when comparing fee tiers for a pool, checking if a Merkl boost is still active, or assessing whether the current pool APR justifies staying in or reranging. Fetches live data from the public ProjectX API.
---

# Skill: ProjectX Pool Stats

Fetches live pool data from the ProjectX DEX API (`https://api.prjx.com`):

- Current APR — base fee APR + active Merkl boost APR
- TVL, 24h volume, 24h fee revenue
- Boost campaign details (reward token, daily USD, end date)
- Break-even rerange days for HYPE/USDC pools (contextualised to LP position size)

## When to use

- User asks "what is the current APR on ProjectX?"
- User wants to check if the APR has changed since they opened their position
- User asks about active boost rewards or Merkl campaigns
- User wants to compare fee tiers (0.05% vs 0.30% for HYPE/USDC)
- User asks whether reranging is worth it at current pool APR
- User wants TVL or volume context before deciding to enter or exit

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
```

## JSON Output Schema

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

## Key Notes

- The API returns a single snapshot — there is no historical APR endpoint. To track APR over time, call this skill periodically and compare.
- `apr` = `baseApr` + Merkl boost. Use `baseApr` for fee income projections; the boost is campaign-dependent and has an end date.
- The break-even rerange line in human output is computed against a fixed $2,449 position size — scale the numbers proportionally for different sizes.
- All numeric fields from the API come back as strings; the script parses them with `parseFloat`.
- The `--fee` flag takes basis points (`500` for 0.05%, `3000` for 0.30%).

Base directory for this skill: file:///Users/marc.buchardt/fun/private/lp-tracker/.opencode/skills/projectx-pool-stats
