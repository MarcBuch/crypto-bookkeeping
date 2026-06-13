---
name: hedge-retrospective
description: Use when the user wants to know if a delta hedge was worth it over a past period. Given a position and lookback window, calculates what a short HYPE position would have returned (price P&L + funding earned) vs actual IL accumulated, and whether the regime signal at entry justified the hedge. Also use when the user asks "would the hedge have paid off?" or wants to review a past hedge decision.
---

# Skill: Hedge Retrospective

Given an LP position and a lookback window, answers: **was a delta hedge worth it?**

Computes for the selected period:
1. What a full or partial short would have returned (price P&L + funding earned)
2. Actual IL accumulated over that period
3. LP-only vs LP + hedge combined P&L
4. Whether the regime signal at entry justified placing the hedge

## When to use

- User asks "would the hedge have paid off?"
- User wants to review a past hedge decision
- User wants to compare LP-only vs LP + delta hedge over a specific window
- Post-mortem analysis after a HYPE price move
- Evaluating whether funding carry alone justified a short

## How to Run

```bash
SKILL_DIR=$(git rev-parse --show-toplevel)/.opencode/skills/hedge-retrospective

# Full period since open (first active position)
bun "$SKILL_DIR/hedge-retrospective.ts"

# Specific position, last 5 days
bun "$SKILL_DIR/hedge-retrospective.ts" 484645 --days 5

# Specific position, half-size hedge, JSON output
bun "$SKILL_DIR/hedge-retrospective.ts" 484645 --size 0.5 --json 2>/dev/null

# Specific position, full period, JSON
bun "$SKILL_DIR/hedge-retrospective.ts" 484645 --json 2>/dev/null
```

## Options

| Flag | Default | Description |
|---|---|---|
| `tokenId` | first active | LP position token ID (also works on closed positions) |
| `--days N` | since open | Lookback window in days |
| `--size 0.5` | `1.0` | Fraction of HYPE delta to short (0.5 = half hedge). Ignored if `config.hedge[tokenId].sizeHype` is set. |
| `--entry PRICE` | config or LP entry | Override short entry price |
| `--stop PRICE` | config or none | Simulate a stop-loss; triggered when daily candle high ≥ stop price |
| `--json` | false | Machine-readable output |

If `config.hedge[tokenId]` exists, `sizeHype`, `entryPriceHype`, and `stopLossPriceHype` are used as defaults automatically — no flags needed for positions that were actually traded.

## JSON Output Schema

```json
{
  "tokenId": "484645",
  "pair": "WHYPE/USDC",
  "fetchedAt": "2026-06-11T09:00:00.000Z",
  "periodDays": 5.24,
  "entryPrice": 59.52,
  "exitPrice": 55.67,
  "priceChangePct": -0.0647,
  "hedgeSize": 1.0,
  "hypeShorted": 13.26,
  "hypeNotionalUsd": 789.3,
  "shortEntryPrice": 58.37,         // actual short fill price (from config.hedge or --entry)
  "lpAbsolutePnlUsd": -24.50,
  "lpFeesUsd": 27.53,
  "lpIlUsd": 6.32,
  "lpNetVsHodlUsd": 21.22,
  "shortPricePnlUsd": 51.05,
  "fundingEarnedUsd": 1.28,
  "totalHedgePnlUsd": 52.33,
  "stopPrice": 61.58,               // stop price if set, else null
  "stoppedOutAt": "2026-06-08",     // date stop triggered (null if not triggered)
  "stoppedOutLoss": -98.56,         // realized short loss at stop (null if not triggered)
  "combinedPnlUsd": 27.83,
  "hedgeBenefitUsd": 52.33,
  "hedgeBenefitPct": 0.0214,
  "regimeAtEntry": "range-bound",
  "driftVolRatioAtEntry": 0.137,
  "dailyVolAtEntry": 0.0607,        // 1-sigma daily vol at entry — contextualises stop tightness
  "volStopLevel": 63.69,            // shortEntryPrice × (1 + 1.5 × dailyVolAtEntry)
  "regimeJustifiedHedge": false,
  "wasHedgeWorthIt": true,
  "analysis": "The hedge was profitable (+$52.33) but the regime at entry (range-bound, ratio 0.137) did not justify it systematically — it was a directional call that paid off.",
  "dailyRows": [
    {
      "date": "2026-06-07",
      "price": 56.60,
      "high": 58.40,               // candle high — used for stop-out detection
      "shortDayPnl": 38.56,
      "fundingEarned": 0.22,
      "stopTriggered": false
    }
  ]
}
```

## Verdict Logic

| wasHedgeWorthIt | regimeJustifiedHedge | Interpretation |
|---|---|---|
| YES | NO | Profitable directional call — not a systematic signal |
| YES | YES | Correct hedge: regime supported it and it paid off |
| NO | YES | Valid signal, wrong timing or price reversal |
| NO | NO | Correct to skip — regime and outcome both say no hedge |

## Important Notes

- `hypeShorted` uses `config.hedge[tokenId].sizeHype` if present, otherwise falls back to `entryAmount0 × hedgeSize`. This ensures retrospectives on actual trades use the real size automatically.
- Stop-out is detected using **daily candle highs** — if the high on any day ≥ the stop price, the short is closed at the stop price on that day. This is conservative (assumes intraday fills at the stop level).
- `dailyVolAtEntry` and `volStopLevel` are surfaced so you can compare the actual stop used against what a 1.5σ vol-appropriate stop would have been. If `stopPrice < volStopLevel`, the stop was inside the expected noise range.
- Funding is approximated using the daily close price as mark price for each hourly funding payment.
- `wasHedgeWorthIt` is true if the hedge was net positive, or if a stop-out loss was smaller than 50% of the LP's IL. For stop-outs, this captures the case where taking a small known loss was better than unlimited downside.
- For closed positions, the full position lifetime is used if `--days` is omitted.
