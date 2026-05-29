# lp-tracker

A monorepo for tracking concentrated liquidity (Uniswap V3-style) positions on [ProjectX DEX](https://projectx.finance) on HyperEVM. Calculates divergence loss (impermanent loss), absolute P&L, fees earned, and opportunity cost vs holding.

## Packages

| Package | Description |
|---------|-------------|
| `packages/core` | Shared library — chain clients, math, DB, services |
| `apps/cli` | CLI tool (all original commands) |
| `apps/api` | Fastify REST API exposing LP position data |
| `apps/web` | Vite React dashboard for LP positions, status, and P&L |

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
| `pricing.coingeckoIds` | *(Optional)* CoinGecko token IDs for live USD pricing |

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

The optional `pricing.coingeckoIds` map enables live USD prices for fee tokens. Keys can be token symbols, token addresses, or ProjectX/HyperEVM wrapped token identifiers used by the app; values must be CoinGecko IDs from the token's CoinGecko URL, such as `usd-coin`, `bitcoin`, `weth`, or `hyperliquid`:

```json
"pricing": {
  "coingeckoIds": {
    "USDC": "usd-coin",
    "UBTC": "bitcoin",
    "WETH": "weth",
    "WHYPE": "hyperliquid",
    "0xTOKEN_ADDRESS_OR_PROJECTX_WRAPPED_TOKEN": "coingecko-token-id"
  }
}
```

Pricing depends on CoinGecko's live simple-price API. P&L output includes USD fee income when `pricing.coingeckoIds` mappings exist and live prices are available. Successful prices are cached briefly in memory to reduce repeated requests. Missing config mappings remain unavailable until `config.json` is updated; failed requests, malformed responses, and unavailable API values for mapped IDs return `null` and are retried after a short cooldown. USD fee income is best-effort mark-to-current-price, not historical execution-time accounting.

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

Output includes: entry/exit prices and amounts, absolute P&L vs initial deposit, divergence loss (LP vs HODL), fees earned, opportunity cost in token1 terms, and USD fee income when live pricing is configured and available.

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

P&L JSON includes USD pricing fields when available, such as `feesValueUsd`, per-token USD fee values, token USD prices, and `usdPriceSource`. Unavailable USD values are returned as `null`.

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

Success responses follow the shape of the corresponding CLI `--json` output, including best-effort USD fee fields such as `feesValueUsd`, per-token USD fee values, token USD prices, and `usdPriceSource` when pricing is available.

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

## Web (`apps/web`)

The web app is a Vite + React + TypeScript + Tailwind dashboard for LP position and P&L data. It uses TanStack Router for client routing, reads `/positions` and `/pnl` from the API, and merges rows by token ID. P&L cards prioritize Fee Income USD when available and show USD unavailable for missing or `null` pricing values.

### Start the app

Run the web app:

```bash
bun run web
```

The web app runs on `http://localhost:5173`.

Run the API separately when you want live LP data:

```bash
bun run api:dev
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_BASE_URL` | `http://localhost:3000` | Base URL for the Fastify API |

### Build

```bash
bun run web:build
bun run web:preview
```

### Web tests

Web tests live outside `src` in `apps/web/tests` and are grouped by type:

| Folder | Purpose |
|--------|---------|
| `tests/unit` | Pure component or function tests with no app shell or API boundary. |
| `tests/integration` | Tests that cross module boundaries, such as API client behavior or router composition. |
| `tests/smoke` | High-level checks that the routed app shell renders critical loading, error, and empty states. |

Run the web tests from the repo root with:

```bash
bun run --filter @lp-tracker/web test
```

Or from `apps/web` with:

```bash
bun run test
```

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

# Web tests (unit + integration + smoke)
cd apps/web && bun test tests
```

## License

MIT
