---
name: regime-checker
description: Use when the user asks about the current market regime, drift/vol ratio, whether LP is appropriate given recent trend strength, or wants to run the monthly playbook regime check. Calculates dailyDrift, dailyVol, and drift/vol ratio from 30 days of price data and maps to the PLAYBOOK.md regime table.
---

# Skill: Regime Checker

Fetches 30+ days of daily candle data from Hyperliquid and computes the drift/vol ratio as defined in PLAYBOOK.md. Maps the ratio to a regime and outputs the corresponding playbook action. Also surfaces open interest from Hyperliquid perp markets.

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

# Human-readable output (default: HYPE)
bun "$SKILL_DIR/check-regime.ts"

# Structured JSON (for programmatic use / agent analysis)
bun "$SKILL_DIR/check-regime.ts" --json 2>/dev/null  # 2>/dev/null suppresses progress output

# Other coins (use the Hyperliquid perp ticker, e.g. BTC, ETH, SOL)
bun "$SKILL_DIR/check-regime.ts" BTC --json 2>/dev/null
```

The coin argument (positional) is the **Hyperliquid perp ticker** (e.g. `HYPE`, `BTC`, `ETH`), not a CoinGecko slug.

## JSON Output Schema

```json
{
  "coin": "HYPE",
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
  "rerangeGuidance": "Rerange on outer-third trigger at standard ±15–17% width. Every cycle >5 days is profitable.",
  "openInterest": 123456789,
  "priceChange7d": 4.12,
  "dailyDrift7d": 0.0058,
  "dailyVol7d": 0.0431,
  "ratio7d": 0.135,
  "regime7d": "range-bound",
  "windowsDiverge": false
}
```

**Outputs note:** `openInterest` (USD) is included in all output — sourced from Hyperliquid `metaAndAssetCtxs`. `action` and `positionGuidance` are identical; prefer `positionGuidance` when combining with `rerangeGuidance` for a complete recommendation.

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
- 32 price points → 31 log returns (32 most-recent daily closes from Hyperliquid)
- Data source: Hyperliquid `candleSnapshot` API (`interval=1d`)

## Workflow

### Step 1: Run the script

```bash
bun "$SKILL_DIR/check-regime.ts" --json 2>/dev/null
```

Parse `ratio`, `regime`, and `openInterest` from JSON output.

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
- `openInterest` as market context

## Important Notes

- The drift/vol ratio uses **absolute drift** — a strong downtrend (negative drift) is as disqualifying for LP as a strong uptrend.
- A 30-day priceChange30d can be large while ratio stays low if volatility is also high. The ratio captures *consistency* of direction, not magnitude.
- The playbook's **exit trigger** is ratio > 1.0 for **7+ consecutive days**, not a single reading. A single spike above 1.0 warrants monitoring, not immediate closure.
- Hyperliquid `candleSnapshot` returns daily candles; each `c` field is the 24h close price. The window is rolling, not calendar-month aligned.
- The coin argument is a **Hyperliquid perp ticker** (uppercase, e.g. `HYPE`), not a CoinGecko slug.
