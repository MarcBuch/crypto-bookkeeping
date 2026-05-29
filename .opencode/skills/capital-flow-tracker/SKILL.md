---
name: capital-flow-tracker
description: Use when the user asks about total P&L across multiple positions or reranges, where fees went after closing a position, whether capital was lost during a rerange, or wants to trace money flow from original entry through to the current position. Also use when config.json is missing closeTx or openTx for a position.
---

# Skill: Capital Flow Tracker

Traces capital across position reranges — finds missing transaction hashes, reconciles fees, and computes true end-to-end P&L across the full position history including top-ups.

## When to use

- User can't see fees in the portal after closing a position
- User asks "was there any loss during the rerange?"
- User wants total P&L from original entry through all reranges to today
- `config.json` is missing `closeTx` or `openTx` for a position
- P&L shows -100% for a closed position (missing closeTx)

## Workflow

### Step 1: Check config.json for missing tx hashes
```
<project-root>/config.json
```
Identify any positions with `status: "closed"` in the positions output but missing `closeTx` in config, or new active positions missing `openTx`.

### Step 2: Find missing transaction hashes on-chain

Fetch the wallet's transaction history from the block explorer:
```
https://explorer.hyperlend.finance/address/{wallet_address}
```
The wallet address is in `config.json` under `wallet`.

Look for `Multicall` transactions to `Project X: Nonfungible Position Manager` (`0xeaD19AE861c29bBb2101E834922B2FEee69B9091`). These are the LP open/close/rerange transactions.

To confirm which token IDs are involved in a transaction, fetch the receipt and decode the logs:
```bash
curl -s "https://rpc.hyperliquid.xyz/evm" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getTransactionReceipt","params":["{txHash}"],"id":1}'
```

Key event signatures to identify in logs:
- `IncreaseLiquidity` (mint/open): topic `0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f` — `topics[1]` is the token ID (hex)
- `DecreaseLiquidity` (close/burn): topic `0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4` — `topics[1]` is the token ID (hex)
- `Transfer` from address zero: NFT mint (new position)
- `Transfer` to address zero: NFT burn (position closed)

Decode token ID: `parseInt(topics[1], 16)`

**Important**: A single `Multicall` tx can both close one position AND open another. In that case, use the same tx hash as `closeTx` for the old position and `openTx` for the new one.

### Step 3: Update config.json
Add the missing tx hashes:
```json
"positions": {
  "TOKEN_ID_1": {
    "openTx": "0x...",
    "closeTx": "0x..."
  },
  "TOKEN_ID_2": {
    "openTx": "0x..."
  }
}
```

### Step 4: Run P&L for all positions
```bash
bun run apps/cli/src/index.ts --json pnl 2>/dev/null
```

### Step 5: Compute end-to-end capital flow

For each chain of positions (original → rerange 1 → rerange 2 → current):

```javascript
// For each position in the chain:
const entryValue  = entryAmount0 * entryPrice + entryAmount1;   // capital deployed
const exitValue   = exitAmount0  * exitPrice  + exitAmount1;    // capital returned

// Top-up at rerange = next position's entry value - this position's exit value
// (positive = user added capital, negative = user withdrew capital)
const topUp = nextEntryValue - exitValue;

// Total capital ever deployed
const totalDeployed = sum of all entryValues (first position only) + sum of all topUps

// Current value
const currentValue = currentAmount0 * currentPrice + currentAmount1;

// End-to-end P&L
const totalPnl = currentValue - totalDeployed;
const totalPnlPct = totalPnl / totalDeployed * 100;

// HODL comparison: hold original tokens + top-ups at current price
const hodlValue = originalAmount0 * currentPrice + originalAmount1 + topUpsInToken1;
const hodlPnl = hodlValue - totalDeployed;
```

### Step 6: Explain where fees went

When a position is closed, fees are **not sent separately** — they are included in the token amounts returned. The LP position accumulates fees as virtual token amounts inside the contract. When liquidity is removed, the fees are unwrapped and returned together with the principal as regular token transfers.

This means:
- Fees appear as extra token0/token1 in the `exitAmount0`/`exitAmount1` vs what pure IL math would predict
- They are then redeployed into the next position (or kept in wallet if not fully redeployed)
- The tracker captures this via `feesCollected0`/`feesCollected1` in the P&L output

### Step 7: Present results

Show a clear table:

| Step | Event | Value (UBTC) | Notes |
|------|-------|-------------|-------|
| Original deposit | Entry into #TOKEN_ID_1 | 0.01000 | |
| Close #TOKEN_ID_1 | Tokens returned | 0.01030 | Includes fees |
| Top-up | Additional capital | +0.00020 | Added at rerange |
| Open #TOKEN_ID_2 | Capital deployed | 0.01050 | |
| Current | Position value | 0.01045 | |
| **Net P&L** | | **+2.50%** | vs total deployed |
| HODL | If held instead | 0.01070 | |
| **LP vs HODL** | | **-1.80%** | Divergence loss |

## Rate limit handling

The HyperEVM RPC rate limits aggressively. If calls fail:
- Wait 15–20 seconds between RPC calls
- Use the block explorer web UI as a fallback for transaction lookup
- Run `bun run apps/cli/src/index.ts` commands with gaps between them

## Important notes

- A -100% P&L for a closed position always means `closeTx` is missing from config — the tracker can't find the withdrawal event and assumes total loss
- Fees are never "lost" when closing — they are always returned as tokens
- The gap between `exitValue` of one position and `entryValue` of the next reveals whether capital was added, withdrawn, or consumed by gas
- Gas costs on HyperEVM are very small (fractions of a cent) and generally negligible in the capital flow analysis
