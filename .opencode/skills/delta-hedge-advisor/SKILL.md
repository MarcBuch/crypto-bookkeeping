---
name: delta-hedge-advisor
description: Use when the user wants to know if a delta hedge on HYPE perps is worth it for their active LP position. Combines live funding rate, fee run rate, IL, and market regime into a single go/no-go recommendation. Also use when the user asks about hedge carry cost, funding rate vs fee income, or whether to short HYPE to protect their LP.
---

# Skill: Delta Hedge Advisor

Combines all inputs needed to decide whether to place a delta hedge on an active LP position:

1. **LP position data** — delta exposure, IL, fees, range proximity
2. **Live funding rate** — from Hyperliquid perps API (hourly, annualized)
3. **Fee run rate** — derived from open tx timestamp + total fees earned
4. **Market regime** — 30-day drift/vol ratio from CoinGecko

Decision equation:
```
Hedge worthwhile if:
  expected_additional_IL > (funding_rate × notional × horizon) + friction
```

## When to use

- User asks "should I hedge my LP with a short?"
- User asks about delta hedging, shorting HYPE perps, or funding carry cost
- User wants to know if a short HYPE position would protect against IL
- User asks for hedge go/no-go recommendation
- Regime or IL analysis is incomplete without funding rate context

## How to Run

```bash
SKILL_DIR=$(git rev-parse --show-toplevel)/.opencode/skills/delta-hedge-advisor

# First active position
bun "$SKILL_DIR/hedge-advisor.ts"

# Specific position (JSON for agent use)
bun "$SKILL_DIR/hedge-advisor.ts" 484645 --json 2>/dev/null
```

## JSON Output Schema

```json
{
  "tokenId": "484645",
  "pair": "WHYPE/USDC",
  "fetchedAt": "2026-06-11T09:00:00.000Z",
  "entryPrice": 59.52,
  "currentPrice": 56.08,
  "priceLower": 36.13,
  "priceUpper": 74.31,
  "pctToLowerBound": 35.6,
  "pctToUpperBound": 32.5,
  "ilPercent": 0.0026,
  "ilUsd": 6.32,
  "feesUsd": 27.53,
  "netVsHodlUsd": 21.22,
  "daysOpen": 5.24,
  "dailyFeeUsd": 5.26,
  "annualizedFeeYield": 0.80,
  "hypeExposure": 17.07,
  "hypeNotionalUsd": 957.0,
  "hourlyFundingRate": 0.0000125,
  "dailyFundingRate": 0.0003,
  "annualizedFundingRate": 0.1095,
  "dailyFundingEarned": 0.29,
  "fundingAsPctOfFees": 0.054,
  "driftVolRatio": 0.137,
  "regime": "range-bound",
  "verdict": "no-hedge",
  "verdictReason": "Range-bound regime, fees covering IL in 1.2 days, 36% buffer to lower bound. No hedge needed.",
  "hedgeBreakEvenDays": 22
}
```

## Verdict Values

| verdict | Meaning |
|---|---|
| `no-hedge` | IL small, fees dominant, range-bound regime — hold |
| `consider-hedge` | Mild trend or range proximity risk — partial hedge worth evaluating |
| `hedge-recommended` | Strong trend regime — LP is underperforming HODL systematically |

## Decision Logic

| Signal | Hedge? |
|---|---|
| Regime = range-bound AND IL covered in <2 days AND >20% to lower | No |
| Regime = mild-trend OR drift/vol > 0.4 | Consider (50% delta) |
| Price within 10% of lower bound | Consider |
| Regime = strong-trend | Recommended — close or full hedge |

## Important Notes

- A short HYPE hedge protects **delta** (directional price exposure), not IL specifically. IL is bidirectional; a short only covers the downside tail.
- When funding is positive (longs pay shorts), the short **earns carry** — the hedge has negative carry cost.
- `hedgeBreakEvenDays` = how long before funding alone pays off the current IL. This is a floor estimate — it ignores future IL accumulation.
- HYPE exposure in LP (`hypeExposure`) shifts as price moves. As price rises the LP sells HYPE; as it falls the LP accumulates HYPE. The reported value is the current snapshot.
