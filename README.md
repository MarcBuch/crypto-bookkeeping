# lp-tracker

A CLI tool to track concentrated liquidity (Uniswap V3-style) positions on [ProjectX DEX](https://projectx.finance) on HyperEVM. It calculates divergence loss (impermanent loss), absolute P&L, fees earned, and opportunity cost vs holding.

## Features

- List all LP positions (active and closed) for a wallet
- Full P&L analysis: absolute gain/loss, divergence loss, opportunity cost vs HODL
- Uncollected fee estimation for active positions
- Historical snapshots stored in a local SQLite database

## Prerequisites

- [Bun](https://bun.sh) v1.0+

## Installation

```bash
git clone <repo-url>
cd lp-tracker
bun install
```

## Configuration

Copy the example config and fill in your details:

```bash
cp config.example.json config.json
```

Edit `config.json`:

| Field | Description |
|-------|-------------|
| `wallet` | Your wallet address to track |
| `rpc` | HyperEVM RPC endpoint (default works out of the box) |
| `chainId` | HyperEVM chain ID (999) |
| `contracts` | ProjectX contract addresses — defaults are correct for mainnet |
| `positions` | *(Optional)* Known open/close tx hashes per token ID for faster event lookups |

The `positions` map speeds up on-chain event lookups by narrowing the block range. Add entries as you open/close positions:

```json
"positions": {
  "TOKEN_ID": {
    "openTx": "0x...",
    "closeTx": "0x..."
  }
}
```

`closeTx` can be omitted for active positions.

> **Note:** `config.json` is gitignored and will never be committed. It contains your wallet address and private position data.

## Usage

### List positions

```bash
bun run src/index.ts positions
```

### Full P&L analysis

```bash
bun run src/index.ts pnl            # all positions
bun run src/index.ts pnl <tokenId>  # specific position
```

Output includes:
- Entry/exit prices and amounts
- Absolute P&L vs initial deposit
- Divergence loss (LP vs HODL)
- Fees earned
- Opportunity cost in token1 terms

### Divergence loss (IL)

```bash
bun run src/index.ts il             # all positions
bun run src/index.ts il <tokenId>   # specific position
```

### Take a snapshot (for historical tracking)

```bash
bun run src/index.ts snapshot
```

Stores the current state of all active positions to a local SQLite database.

### View history

```bash
bun run src/index.ts history <tokenId>
bun run src/index.ts history <tokenId> --limit 50
```

### JSON output (for scripting / agent use)

Append `--json` to any command to get structured JSON on stdout (all other output goes to stderr):

```bash
bun run src/index.ts --json pnl 2>/dev/null
bun run src/index.ts --json positions 2>/dev/null
```

## Rate limits

The HyperEVM public RPC has aggressive rate limits. If a command fails with a rate limit error, wait 15–30 seconds and retry.

## Database

Snapshots and cached entry data are stored in `data/lp-tracker.db` (SQLite). This file is gitignored.

## License

MIT
