---
name: delta-hedge-advisor
description: Use when the user wants to know if a delta hedge on HYPE perps is worth it for their active LP position. Combines live funding rate, fee run rate, IL, and market regime into a single go/no-go recommendation. Also use when the user asks about hedge carry cost, funding rate vs fee income, or whether to short HYPE to protect their LP.
---

# Skill: Delta Hedge Advisor

Combines all inputs needed to decide whether to place a delta hedge on an active LP position:

1. **LP position data** — delta exposure, IL, fees, range proximity
2. **Live funding rate / live mark** — from Hyperliquid `metaAndAssetCtxs` (hourly, annualized; markPx is the hedge price source)
3. **Fee run rate** — derived from open tx timestamp + total fees earned
4. **Market regime** — 30-day drift/vol ratio from Hyperliquid candleSnapshot

Decision equation:
```
Hedge worthwhile if:
  expected_additional_IL > (funding_rate × notional × horizon) + slippage_and_margin_cost
```
In practice the script uses a signal table (regime + range proximity + IL/fee ratio) rather
than solving this inequality directly — the equation is the conceptual frame.

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

  // Position
  "entryPrice": 59.52,
  "currentPrice": 56.08,
  "priceLower": 36.13,
  "priceUpper": 74.31,
  "pctToLowerBound": 35.6,          // % above lower bound
  "pctToUpperBound": 32.5,          // % below upper bound

  // IL & fees
  "ilPercent": 0.0026,              // divergence loss as decimal
  "ilUsd": 6.32,
  "feesUsd": 27.53,
  "netVsHodlUsd": 21.22,
  "daysOpen": 5.24,
  "dailyFeeUsd": 5.26,
  "annualizedFeeYield": 0.80,       // as decimal (0.80 = 80%)

  // Delta exposure (V3 gamma-aware)
  "hypeExposure": 17.07,            // HYPE currently in LP
  "hypeNotionalUsd": 957.0,
  "liquidityConstant": 1234.5,      // V3 L value — used for gamma-aware sizing
  "hypeExposureAtLowerBound": 28.4, // max HYPE if price falls to lower bound
  "hypeExposureAtUpperBound": 0,    // always 0 — LP is fully USDC at upper bound

  // Funding (from Hyperliquid perps API)
  "hourlyFundingRate": 0.0000125,
  "dailyFundingRate": 0.0003,
  "annualizedFundingRate": 0.1095,
  "dailyFundingEarned": 0.29,       // USD earned per day if short placed (positive = funding favors shorts)
  "fundingAsPctOfFees": 0.054,      // dailyFundingEarned / dailyFeeUsd
  "openInterest": 1234567.8,        // open interest in HYPE (from metaAndAssetCtxs)

  // Market regime
  "driftVolRatio": 0.137,           // |mean daily return| / daily vol (30-day window, from HL candleSnapshot)
  "regime": "range-bound",          // "range-bound" | "mild-trend" | "strong-trend"
  "dailyVol": 0.0683,               // 1-sigma daily log-return vol (30-day) — used for vol-stop derivation
  "high7d": 65.80,                  // highest daily close over last 7 days — structural stop reference
  "low7d": 52.61,                   // lowest daily close over last 7 days

  // Verdict 1: fee-optimisation (is the hedge cost justified by fee income?)
  "verdict": "no-hedge",            // "no-hedge" | "consider-hedge" | "hedge-recommended"
  "verdictReason": "Range-bound regime, fees covering IL in 1.2 days, 36% buffer to lower bound. No hedge needed.",
  "hedgeBreakEvenDays": 22,         // days until funding earned alone covers current IL (optimistic — ignores future IL)

  // Verdict 2: capital preservation (is the downside delta risk worth hedging regardless of fees?)
  "capitalPreservationVerdict": "no-hedge",
  "capitalPreservationReason": "Downside scenarios are within acceptable range relative to hedge carry cost.",

  // Capital preservation detail
  "dailyIlRate": 1.21,              // USD of IL accumulating per day
  "hedgeCostToIlRatio": 0.24,       // dailyFundingEarned / dailyIlRate (<1 = hedge cheaper than IL)
  "downsideScenarios": [
    { "dropPct": 0.10, "deltaLossUsd": 95.7, "hedgeCarryToDateUsd": 2.03 },
    { "dropPct": 0.20, "deltaLossUsd": 191.4, "hedgeCarryToDateUsd": 2.03 },
    { "dropPct": 0.30, "deltaLossUsd": 287.1, "hedgeCarryToDateUsd": 2.03 }
  ],

  // Sizing
  "recommendedHedgeHype": 8.5,      // suggested short size (V3-aware, capped at 50% of lower-bound exposure)
  "recommendedHedgeReason": "Sized so close trigger falls at LP entry price...",

  // Upside risk (LP sheds HYPE as price rises — short becomes overhedged)
  "upsideScenarios": [
    {
      "risePct": 0.05,
      "newPrice": 58.88,
      "lpHypeAtPrice": 14.2,        // HYPE remaining in LP at that price
      "shortLossUsd": 40.4,
      "overhedgeHype": -5.7,        // negative = short is smaller than LP delta (underhedged)
      "fees7dUsd": 36.8,
      "net7dUsd": -3.6              // fees + funding - short loss over 7 days
    }
  ],

  // Triggers for managing the short
  "hedgeCloseTriggerPrice": 61.20,  // close short here — 7-day income equals total short loss
  "hedgeReduceTriggerPrice": 58.64, // reduce to 50% here
  "hedgeCloseTriggerReason": "Close at $61.20 (+9.1% from current): 7-day income ($X) equals total short loss at that price.",

  // Stop loss scenarios — dynamically derived, not hardcoded prices
  // Four candidates: LP entry price, LP upper-third trigger, 1.5σ vol stop, 7d high +1%
  // Deduplicated if within $0.30 of each other (higher candidate kept)
  "stopLossScenarios": [
    {
      "stopPrice": 61.58,
      "bufferPct": 2.8,
      "shortLossUsd": 48.57,
      "lpGainUsd": 20.31,
      "netCombinedLossUsd": 28.26,
      "daysFeesToRecover": 6.5,
      "maxSizeForFeeConstraint": 30.5  // largest short (HYPE) where net loss <= 7 days of fees at this stop
    }
  ]
}
```

## Verdict Values

Both `verdict` (fee-optimisation) and `capitalPreservationVerdict` use the same three states:

| value | Meaning |
|---|---|
| `no-hedge` | No systematic case for a hedge |
| `consider-hedge` | Risk is elevated — partial hedge (50% delta) worth evaluating |
| `hedge-recommended` | Strong case for hedging |

The two verdicts ask different questions:
- **`verdict` (fee-optimisation):** Is the hedge carry cost justified relative to the current fee run rate and IL level?
- **`capitalPreservationVerdict` (capital preservation):** Is the downside delta risk large enough that a hedge is cheap insurance, regardless of fees?

Surface both to the user; they can disagree.

## Decision Logic

### Verdict 1 — Fee-optimisation (`verdict`)

Evaluated in priority order; first matching rule wins:

| Signal | Result |
|---|---|
| Regime = strong-trend (drift/vol > 1.0) | `hedge-recommended` — LP selling into directional move |
| Regime = range-bound AND IL covered in <2 days AND >20% to lower bound | `no-hedge` |
| Regime = mild-trend OR drift/vol > 0.4 | `consider-hedge` (50% delta) |
| Price within 10% of lower bound | `consider-hedge` — out-of-range risk elevated |
| Fallback | `no-hedge` |

### Verdict 2 — Capital preservation (`capitalPreservationVerdict`)

Evaluated in priority order; first matching rule wins:

| Signal | Result |
|---|---|
| (−20% HYPE drop loss) / (7-day hedge carry) > 10 | `hedge-recommended` — hedge is cheap insurance |
| Daily hedge carry < daily IL accumulation rate | `hedge-recommended` — hedge is cheaper per day than existing IL drag |
| 7-day price change < −5% AND HYPE notional > $500 | `consider-hedge` (50% delta) |
| Fallback | `no-hedge` |

## Important Notes

- A short HYPE hedge protects **delta** (directional price exposure), not IL specifically. IL is bidirectional; a short only covers the downside tail.
- When funding is positive (longs pay shorts), the short **earns carry** — the hedge has negative carry cost.
- `hedgeBreakEvenDays` = how long before funding alone pays off the current IL. This is an optimistic estimate — it treats current IL as fixed and ignores the additional IL that will accumulate while waiting.
- Close/reduce triggers keep an explicit volatility buffer; income-parity is only a sanity check, not the sole trigger.
- HYPE exposure in LP (`hypeExposure`) shifts as price moves. As price rises the LP sells HYPE; as it falls the LP accumulates HYPE. The reported value is the current snapshot.
- **Sizing discipline:** Always set the stop at a technically valid level first (`high7d * 1.01` or `1.5σ vol stop`), then use `maxSizeForFeeConstraint` to determine the position size. Never work backwards from break-even size to find the stop — that was the failure mode that produced the oversized hedge closed at a loss on Jun 12.
- **Stop candidates** are derived dynamically: LP entry price, LP upper-third trigger, 1.5σ vol stop (`currentPrice × (1 + 1.5 × dailyVol)`), and 7d structural high +1%. Hardcoded stops are not used.
