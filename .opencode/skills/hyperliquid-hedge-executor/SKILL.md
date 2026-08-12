---
name: hyperliquid-hedge-executor
description: Read-only Hyperliquid hedge execution analysis for HYPE or another perp ticker. Uses public market data only and never places orders or touches wallet state.
---

# Skill: Hyperliquid Hedge Executor

Use this skill when you want a read-only execution view for a HYPE hedge.

It pulls public Hyperliquid data and reports:

- live mark and book mid
- spread, top-of-book depth, and imbalance
- estimated slippage for a short entry of the requested size
- 1h and 4h candle structure with VWAP20, ATR14, 5/20 momentum, and nearby swing support/resistance
- current funding, public predicted funding (with fallback note if unavailable), and funding history summary
- current open interest in USD plus the underlying coin-unit amount; short-window OI change is snapshot-only unless a second sample is explicitly taken
- cautious rebound and breakdown hedge-entry candidates

## Safety rules

- Read-only only
- No account, wallet, position, or order endpoints
- No order placement
- No state changes
- Use OCO/bracket language as a warning only, not as an instruction to submit orders

## Run

```bash
SKILL_DIR=$(git rev-parse --show-toplevel)/.opencode/skills/hyperliquid-hedge-executor

bun "$SKILL_DIR/hedge-executor.ts"
bun "$SKILL_DIR/hedge-executor.ts" HYPE --size 4.2 --json
bun "$SKILL_DIR/hedge-executor.ts" BTC --size 1.0 --json
```

## Output notes

- Default symbol: `HYPE`
- Default size: `4.2` HYPE
- `--json` emits a structured analysis object
- Funding prediction uses public `predictedFundings` when available; otherwise it falls back to current funding with an explicit note
- OI short-window change is reported as snapshot-only unless the script is extended to sample twice
