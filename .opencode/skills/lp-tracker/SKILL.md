---
name: lp-tracker
description: Use when the user asks about their DeFi liquidity positions, impermanent loss, divergence loss, LP P&L, position status, or anything related to their ProjectX/HyperEVM LP tracking. Also use when they want to check position performance, take snapshots, or view historical data.
---

# LP Tracker Skill

A CLI tool for tracking concentrated liquidity (Uniswap V3-style) positions on ProjectX DEX on HyperEVM. It calculates divergence loss (impermanent loss), absolute P&L, fees earned, and opportunity cost vs holding.

## How to Run Commands

This is a monorepo. Use `git rev-parse --show-toplevel` to locate the repo root from any working directory, then reference the CLI entry point relative to it. This works regardless of where the agent or shell is currently sitting.

Use `--json` flag for structured output that you can parse programmatically. Always use `--json` when you need to analyze the data or answer questions about it.

```bash
# Resolve repo root dynamically — works from any directory inside the repo
REPO=$(git rev-parse --show-toplevel)

# Always redirect stderr when using --json to get clean output
bun run "$REPO/apps/cli/src/index.ts" --json <command> 2>/dev/null
```

## Available Commands

### List Positions
```bash
REPO=$(git rev-parse --show-toplevel)
bun run "$REPO/apps/cli/src/index.ts" --json positions 2>/dev/null
```
Returns all LP positions (active and closed) with current amounts, price ranges, and status.

### Full P&L Analysis (Recommended)
```bash
REPO=$(git rev-parse --show-toplevel)
bun run "$REPO/apps/cli/src/index.ts" --json pnl 2>/dev/null           # All positions
bun run "$REPO/apps/cli/src/index.ts" --json pnl <tokenId> 2>/dev/null  # Specific position
```
Returns comprehensive P&L data including:
- `absolutePnlPercent`: Actual gain/loss vs initial deposit (positive = made money)
- `divergenceLossPercent`: Performance vs simply holding (negative = underperformed HODL)
- `opportunityCostInToken1`: Dollar amount left on the table vs HODL
- `netVsHodlPercent`: Net performance vs HODL including fees earned
- `feesValueInToken1`: Total fees earned
- Entry/exit prices, amounts deposited/withdrawn

### Divergence Loss (Impermanent Loss)
```bash
REPO=$(git rev-parse --show-toplevel)
bun run "$REPO/apps/cli/src/index.ts" --json il 2>/dev/null           # All positions
bun run "$REPO/apps/cli/src/index.ts" --json il <tokenId> 2>/dev/null  # Specific position
```
Returns divergence loss metrics focused on IL comparison with HODL.

### Take Snapshot (for historical tracking)
```bash
REPO=$(git rev-parse --show-toplevel)
bun run "$REPO/apps/cli/src/index.ts" snapshot 2>&1
```
Stores current state of all active positions to SQLite for historical analysis.

### View History
```bash
REPO=$(git rev-parse --show-toplevel)
bun run "$REPO/apps/cli/src/index.ts" --json history <tokenId> 2>/dev/null
```
Returns historical snapshots for a position (requires prior snapshots).

## JSON Output Schema

### positions
```json
{
  "positions": [{
    "tokenId": "123456",
    "token0": { "address": "0x...", "symbol": "WHYPE", "decimals": 18 },
    "token1": { "address": "0x...", "symbol": "UBTC", "decimals": 8 },
    "fee": 3000,
    "feePercent": 0.3,
    "tickLower": -303360,
    "tickUpper": -301200,
    "priceLower": 0.000600,
    "priceUpper": 0.000800,
    "currentPrice": 0.000700,
    "liquidity": "50000000000000",
    "status": "active",
    "inRange": true,
    "currentAmount0": 10.0,
    "currentAmount1": 0.00800
  }]
}
```

### pnl
```json
{
  "positions": [{
    "tokenId": "123456",
    "pair": "WHYPE/UBTC",
    "token0Symbol": "WHYPE",
    "token1Symbol": "UBTC",
    "status": "active",
    "entryPrice": 0.000680,
    "exitPrice": 0.000700,
    "priceChangePercent": 0.029,
    "entryAmount0": 10.0,
    "entryAmount1": 0.00680,
    "exitAmount0": 9.5,
    "exitAmount1": 0.00750,
    "feesCollected0": 0.05,
    "feesCollected1": 0.00004,
    "feesValueInToken1": 0.000075,
    "entryValueInToken1": 0.01360,
    "exitValueInToken1": 0.01415,
    "holdValueInToken1": 0.01400,
    "absolutePnlInToken1": 0.000550,
    "absolutePnlPercent": 0.0404,
    "divergenceLossPercent": -0.0010,
    "opportunityCostInToken1": 0.000014,
    "netVsHodlPercent": 0.011,
    "priceLower": 0.000600,
    "priceUpper": 0.000800
  }]
}
```

## Key Concepts

- **Divergence Loss (DL)**: How much the LP position underperformed vs simply holding the tokens. Always negative or zero. This is NOT an actual loss - it's opportunity cost.
- **Absolute P&L**: Actual gain/loss compared to your initial deposit. Positive means you made money in absolute terms.
- **Opportunity Cost**: The dollar amount you would have earned additionally if you had just held instead of LPing.
- **Net vs HODL**: Divergence loss offset by fees earned. If positive, fees more than compensated for IL.
- **In Range**: Whether the current price is within the position's tick range. Out-of-range positions earn no fees.

## Configuration

The tracker is configured via `config.json` in the project root. Key fields:
- `wallet`: The wallet address being tracked
- `contracts`: ProjectX contract addresses on HyperEVM
- `positions`: Known transaction hashes for fast event lookups (keyed by tokenId)

When a new position is opened, add its open tx hash to `config.json`:
```json
"positions": {
  "TOKEN_ID": { "openTx": "0x..." }
}
```
When closed, add the close tx:
```json
"positions": {
  "TOKEN_ID": { "openTx": "0x...", "closeTx": "0x..." }
}
```

## Important Notes

- The HyperEVM public RPC has aggressive rate limits. If commands fail with rate limit errors, wait 30 seconds and retry.
- All values denominated "InToken1" are in the second token of the pair (e.g., USDC for WHYPE/USDC, UBTC for WHYPE/UBTC).
- Percentages in JSON are decimals (0.01 = 1%), not already multiplied by 100.
- The `snapshot` command only tracks active positions. Run it periodically to build history.
