---
name: regime-checker
description: Use when the user asks about the current market regime, drift/vol ratio, whether LP is appropriate given recent trend strength, or wants to run the monthly playbook regime check. Calculates dailyDrift, dailyVol, and drift/vol ratio from 30 days of price data and maps to the PLAYBOOK.md regime table.
---

# Skill: Regime Checker

Fetches 30 days of daily price data from CoinGecko and computes the drift/vol ratio as defined in PLAYBOOK.md. Maps the ratio to a regime and outputs the corresponding playbook action.

## When to use

- User asks "what's the current regime?"
- User asks "should I be LPing right now?"
- User wants to run the monthly regime check
- User asks about drift/vol ratio
- LP analysis references regime as unknown or stale
- Before entering or reranging a position

## How to Run

```bash
SKILL_DIR=$(git rev-parse --show-toplevel)/.opencode/skills/regime-checker

# Human-readable output (default: hyperliquid)
bun "$SKILL_DIR/check-regime.ts"

# Structured JSON (for programmatic use / agent analysis)
bun "$SKILL_DIR/check-regime.ts" --json 2>/dev/null  # 2>/dev/null suppresses progress output

# Other coins
bun "$SKILL_DIR/check-regime.ts" bitcoin --json 2>/dev/null
```

## JSON Output Schema

```json
{
  "coin": "hyperliquid",
  "symbol": "HYPE",
  "fetchedAt": "2026-06-04T20:45:30.600Z",
  "days": 31,
  "currentPrice": 67.52,
  "priceChange30d": 61.49,
  "dailyDrift": 0.0155,
  "dailyVol": 0.0547,
  "ratio": 0.283,
  "regime": "range-bound",
  "action": "Full position. Normal rerange discipline (outer-third trigger).",
  "positionGuidance": "Full position. Normal rerange discipline (outer-third trigger).",
  "rerangeGuidance": "Rerange on outer-third trigger at standard ±15–17% width. Every cycle >5 days is profitable."
}
```

Note: `action` and `positionGuidance` are currently identical — both carry the high-level regime action. Use either; prefer `positionGuidance` when combining with `rerangeGuidance` for a complete recommendation.

## Regime Table (from PLAYBOOK.md)

| Ratio | Regime | Action |
|---|---|---|
| < 0.5 | Range-bound | Full position, normal rerange discipline |
| 0.5 – 1.0 | Mild trend | Reduce position size 50%, widen range |
| > 1.0 | Strong trend | **Pause LP entirely. Just hold HYPE.** |

## Calculation

```
dailyDrift = mean(daily log returns over 30 days)
dailyVol   = std dev(daily log returns over 30 days)
ratio      = abs(dailyDrift) / dailyVol
```

- Uses absolute value of drift — both strong uptrends and downtrends are directional
- 31 price points → 30 log returns
- Data source: CoinGecko free API (`/coins/{id}/market_chart?interval=daily`)

## Workflow

### Step 1: Run the script

```bash
bun "$SKILL_DIR/check-regime.ts" --json 2>/dev/null
```

Parse `ratio` and `regime` from JSON output.

### Step 2: Cross-reference with position state

Get current position data by running the lp-tracker skill or reading `config.json`. Combine regime with LP position data:

| Regime | Position in range? | Action |
|---|---|---|
| Range-bound | Yes | Hold, rerange on outer-third trigger |
| Range-bound | No (out of range) | Rerange immediately |
| Mild trend | Yes | Reduce to 50% size on next rerange, widen range |
| Mild trend | No | Close and sit out, or reopen with 50% capital |
| Strong trend | Any | **Only close LP after ratio > 1.0 for 7+ consecutive days.** A single spike warrants monitoring, not immediate closure. Hold HYPE unencumbered once confirmed. |

### Step 3: Report to user

Always include:
- `ratio` value and `regime` label
- Comparison with the previous ratio recorded in PLAYBOOK.md (search for the most recent regime check entry)
- Playbook action
- Whether entry/rerange is advisable right now

## Important Notes

- The drift/vol ratio uses **absolute drift** — a strong downtrend (negative drift) is as disqualifying for LP as a strong uptrend.
- A 30-day priceChange30d can be large while ratio stays low if volatility is also high. The ratio captures *consistency* of direction, not magnitude.
- The playbook's **exit trigger** is ratio > 1.0 for **7+ consecutive days**, not a single reading. A single spike above 1.0 warrants monitoring, not immediate closure.
- CoinGecko's free API returns daily candles; each point is a 24h close. The window is rolling, not calendar-month aligned.
