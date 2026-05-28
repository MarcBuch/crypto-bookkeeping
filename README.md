# lp-tracker

A monorepo for tracking concentrated liquidity (Uniswap V3-style) positions on [ProjectX DEX](https://projectx.finance) on HyperEVM. Calculates divergence loss (impermanent loss), absolute P&L, fees earned, and opportunity cost vs holding.

## Packages

| Package | Description |
|---------|-------------|
| `packages/core` | Shared library — chain clients, math, DB, services |
| `apps/cli` | CLI tool (all original commands) |
| `apps/api` | Fastify REST API exposing LP position data |

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

The `positions` map speeds up on-chain event lookups by narrowing the block range:

```json
"positions": {
  "TOKEN_ID": {
    "openTx": "0x...",
    "closeTx": "0x..."
  }
}
```

`closeTx` can be omitted for active positions.

> **Note:** `config.json` is gitignored and will never be committed.

Config resolution order (for both CLI and API):
1. `LP_TRACKER_CONFIG` env var (absolute or relative to cwd)
2. `config.json` in the current working directory
3. `config.json` at the repo root (development fallback)

Database path resolution:
1. `LP_TRACKER_DATA_DIR` env var → `<dir>/lp-tracker.db`
2. `data/` in the current working directory
3. `data/lp-tracker.db` at the repo root (development fallback)

---

## CLI (`apps/cli`)

### Run commands

```bash
# From repo root (uses bun workspaces filter):
bun run cli positions
bun run cli pnl
bun run cli il
bun run cli snapshot
bun run cli history <tokenId>

# Or directly from apps/cli:
cd apps/cli
bun run start positions
bun run pnl
bun run il
bun run snapshot
bun run history
```

### Commands

#### List positions

```bash
bun run cli positions
```

#### Full P&L analysis

```bash
bun run cli pnl            # all positions
bun run cli pnl <tokenId>  # specific position
```

Output includes: entry/exit prices and amounts, absolute P&L vs initial deposit, divergence loss (LP vs HODL), fees earned, opportunity cost in token1 terms.

#### Divergence loss (IL)

```bash
bun run cli il             # all positions
bun run cli il <tokenId>   # specific position
```

#### Take a snapshot (for historical tracking)

```bash
bun run cli snapshot
```

Stores the current state of all active positions to `data/lp-tracker.db`.

#### View history

```bash
bun run cli history <tokenId>
bun run cli history <tokenId> --limit 50
```

### JSON output (for scripting / agent use)

Append `--json` to any command to get structured JSON on stdout:

```bash
bun run --filter @lp-tracker/cli start -- --json pnl 2>/dev/null
bun run --filter @lp-tracker/cli start -- --json positions 2>/dev/null
```

---

## API (`apps/api`)

### Start the server

```bash
# From repo root:
bun run api           # production
bun run api:dev       # watch mode

# Or directly:
cd apps/api
bun run start         # PORT=3000 by default
PORT=8080 bun run start
```

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/positions` | All LP positions |
| `GET` | `/positions/:tokenId` | Single position by token ID |
| `GET` | `/pnl` | P&L for all positions |
| `GET` | `/positions/:tokenId/pnl` | P&L for a specific position |
| `GET` | `/il` | Divergence loss for all positions |
| `GET` | `/positions/:tokenId/il` | Divergence loss for a specific position |
| `GET` | `/positions/:tokenId/history` | Historical snapshots (`?limit=20`) |
| `GET` | `/positions/:tokenId/snapshots` | All recent snapshots (up to 200) |

### Response format

Success responses follow the shape of the corresponding CLI `--json` output.

Error responses:
```json
{ "error": "<message>" }
```

HTTP status codes:
- `400` — invalid parameter (non-numeric tokenId, bad limit)
- `404` — position not found or unknown route
- `503` — RPC rate limited (retry after a few seconds)
- `500` — internal server error

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port to listen on |
| `LP_TRACKER_CONFIG` | auto-resolved | Path to config.json |
| `LP_TRACKER_DATA_DIR` | auto-resolved | Directory for lp-tracker.db |

---

## Rate limits

The HyperEVM public RPC has aggressive rate limits. If a command or API call fails with a 503, wait 15–30 seconds and retry.

## Database

Snapshots and cached entry data are stored in `data/lp-tracker.db` (SQLite, gitignored).

## Testing

```bash
# Core package tests (unit + adversarial)
cd packages/core && bun test src/test

# API tests (in-process, no network required)
cd apps/api && bun test src/test
```

## License

MIT
