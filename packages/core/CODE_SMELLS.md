# Code Smell Analysis — `packages/core/src`

> Generated: 2026-06-08 · Last audited: 2026-06-09 (updated 2026-06-09 post-refactor)

---

## Critical

### `getPnLView` — 491 lines, 7+ unrelated concerns (`services/pnl.ts:86–576`)

Entry resolution, exit resolution, fee calculation, USD pricing (with 2-level fallback), PnL math, and DB persistence all live in one function. Needs to be decomposed into `resolveEntryData`, `resolveExitData`, `resolveUsdPrices`, with the main function orchestrating them.

---

## High — Duplication

| # | Pattern | Locations |
|---|---|---|
| 1 | HyperSync client construction block (6 lines, verbatim) | `il.ts:41`, `pnl.ts:95`, `snapshot.ts:25` |
| 2 | `logsWindowBlocks` derivation | same 3 files |
| 3 | `findOpenEvent` + error handling + `upsertPosition` block | `il.ts`, `pnl.ts` (3×), `snapshot.ts` |
| ~~4~~ | ~~`getHistoricalEurPrice` ≈ `getHistoricalUsdPrice` (~95% identical)~~ | **FIXED** — unified into `getHistoricalPrice(currency)` |
| 5 | HyperSync pagination loop (paginate + timestamp join + dedup) | `hypersync.ts` × 3 functions |
| 6 | LP entry builder token-field selection block | `tax-transactions.ts:241`, `291`, `341` |
| 7 | `buildLpWithdrawalEntry` ≈ `buildLpFeeEntry` (~90% identical) | `tax-transactions.ts:283`, `333` |
| 8 | `slot0` ABI inlined verbatim, duplicating `poolAbi` | `events.ts:644`, `abis.ts:88` |
| 9 | Three single-function ERC-20 ABIs duplicating `erc20Abi` | `token-metadata.ts:6–34`, `abis.ts:179` |

---

## High — Architecture

### Two parallel token metadata systems with no policy

- `getTokenInfo` in `chain/pools.ts` — in-memory cache only, not persisted
- `resolveTokenMetadata` in `chain/token-metadata.ts` — DB-persisted cache

Both resolve the same ERC-20 metadata. Used by different service files with no consistent policy.

### God modules

| File | Lines | Concerns mixed |
|---|---|---|
| `services/tax-transactions.ts` | 1086 | 3 public APIs, LP entry builders, HyperSync normalisation, explorer pagination, EUR enrichment |
| `db/store.ts` | 777 | positions, snapshots, tax transactions, view caches, sync state |
| `math/divergence-loss.ts` | 438 | tick/price conversions, token amounts, divergence loss, fee math, full PnL |
| `chain/events.ts` | 674 | open/close event resolution, `getPoolPriceAtBlock` (unrelated) |

### TLS disabled globally at import time (`chain/client.ts:9`)

```ts
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
```

This runs the moment any consumer imports `client.ts`, disabling TLS verification for **all** HTTPS connections in the process. A hidden import side effect and a security concern.

### Module-level mutable caches leak between tests

`tokenCache`/`poolAddressCache` in `chain/pools.ts:35–38` and `priceCache`/`historicalPriceCache` in `services/pricing.ts:25–26` are module singletons with no `clear()` or reset API. In the `bun test` shared-process mode (warned against in `AGENTS.md`), these caches leak between test files.

### Oversized functions beyond `getPnLView`

| Function | Lines | File |
|---|---|---|
| `findCloseEvent` | ~222 | `chain/events.ts:195–417` |
| `getILView` | ~233 | `services/il.ts:38–297` |
| `takeSnapshot` | ~187 | `services/snapshot.ts:22–239` |
| `findOpenEvent` | ~117 | `chain/events.ts:70–186` |

---

## High — Naming / Correctness

### `calculateDivergenceLoss` result called and mostly discarded (`services/il.ts:202–210`)

`dlResult` is computed and only `dlResult.entryPrice` is used (line 254). All other outputs (`valueLp`, `valueHold`, `divergenceLoss`) are independently recalculated ~20 lines later, bypassing the math module. The first argument is also always `1n` due to `BigInt(cond ? 1 : 1)` — likely a stale TODO.

### `exitAmount0/1` used as "current amounts" for active positions (`services/pnl.ts:294–309`)

The "exit" prefix implies closure. For open positions these hold the *current* pool amounts.

### ~~Ticket IDs in production comments~~

**FIXED** — `(m2t5 fast path)` and `(m2t4)` removed from `pnl.ts`.

---

## Medium — Missing Abstractions

| Missing helper | Current situation | Count |
|---|---|---|
| `toHumanAmount(raw: bigint, decimals: number)` | `Number(amount) / 10 ** decimals` inlined | **26 times** |
| `TICK_BASE = 1.0001` | magic literal | **12 times** |
| `tickToAdjustedPrice(tick, d0, d1)` | `1.0001 ** tick * 10 ** (d0 - d1)` inlined outside math module | 4 times |
| `persistPositionEntry(pos, openEvent, tokens)` | `deriveEntryPrice → upsertPosition` block copied | 5 times |
| `createHyperSyncClientFromConfig(config)` | 6-line construction block copied | 3 times |
| `resolveLogsWindow(config)` | 4-line derivation copied | 3 times |
| `isActivePosition(pos)` | `pos.liquidity > 0n` inlined | 4 times |
| `assertValidUrl(path, field, value)` | `!URL.canParse(v) → throw` pattern | 2 times |
| `upsertViewCache(table, tokenId, data, syncedAt)` | `upsertPositionViewCache` and `upsertPnLViewCache` are identical modulo table name | — |
| `paginateHyperSync<T>(client, query, normalise)` | full pagination shell with block-timestamp join copied | 3 times |

---

## Medium — Inconsistent Patterns

### ~~Nullish checks~~

~~`services/il.ts:67`, `pnl.ts:123`, `snapshot.ts:43` use `!== undefined && !== null`.~~ **FIXED** — all three sites now use `!= null`.

### Error logging prefix

Service files use `[lp-tracker]` prefix. `chain/events.ts` uses 4-space indent with no prefix. `tax-transactions.ts` uses function-name prefixes (e.g. `[enrichTaxTransactionsEurValues]`). No consistent log convention.

### `syncedAt` diverges within a single run

`syncTaxTransactions` creates `new Date().toISOString()` at `tax-transactions.ts:392`. `syncLpTaxFlows` (called from within it) creates its own `new Date().toISOString()` at line 84. Tax transactions and LP flows get different `synced_at` timestamps, preventing atomic identification of "records synced in this run".

---

## Medium — Error Handling

| Issue | Location |
|---|---|
| `getHistoricalPrice` writes negative-cache in 3 separate branches | `pricing.ts` |
| `syncLpTaxFlows` silently converts RPC failures to `null` timestamps | `tax-transactions.ts:96–102` |
| Some positions throw `NotFoundError`, others silently `continue` on `findOpenEvent` `not_found` — callers cannot predict which | `il.ts:59` vs `pnl.ts` |

---

## Medium — Complexity

### USD price resolution in `getPnLView` (`pnl.ts:505–556`)

Three levels of nesting with double try/catch:
```
if (closed)
  if (usd prices stored) → use them
  else
    try { getHistoricalPrice(..., "usd") } catch {}
    if (still null) try { getUsdPrices } catch {}
else (active)
  try { getUsdPrices } catch {}
```

### Entry data resolution in `getPnLView` (`pnl.ts:152–291`)

Four interleaved code paths: `posConfig.openTx` fast-path → `storedPos.open_tx` fast-path → `hasStoredEntry` cache-only → slow log scan. These form a priority chain that would be clearer as early returns in a dedicated `resolveEntryAmounts` function.

### `findCloseEvent` — 4 paths in 222 lines (`events.ts:195–417`)

Fast-path and slow-path each branch again on `hyperSyncClient` presence, giving: SDK fast, viem fast, SDK slow, viem slow — all nested. The SDK and viem implementations should be separate functions.

---

## Medium — TypeScript Anti-Patterns

### `as any` for viem decoded event args × 15

`chain/events.ts:123,171–173,244,318,334–335,379–380,476,544–545,579,581,594–595` — unnecessary if `decodeEventLog` is called with the correct ABI generic parameter.

### Non-null assertions on optional DB fields (`pnl.ts:224,227–228,230,326–329,331–333,337,364–367`)

`storedPos!.exit_amount0!`, `storedPos!.entry_liquidity!` etc. Fragile — if a migration changes nullability, TypeScript won't warn.

### `bigint → float → bigint` precision round-trip (`pnl.ts:318–319`)

`calculateUnclaimedFees` returns floats converted from bigints. They are then multiplied back and re-converted to bigint for `calculateFullPnL`, which converts to float again. The round-trip introduces floating-point error.

### `canScanLogs` casts typed `Client` to `any` to duck-check `getLogs` (`events.ts:447–449`)

`getLogs` is always present on the typed `Client`. The check exists for test mocks. Should be replaced with an optional interface or removed.

---

## Low — Magic Values

| Value | Meaning | Occurrences |
|---|---|---|
| `1.0001` | Uniswap V3 tick base | 12 (should be `TICK_BASE`) |
| `18` | Native token decimals | `history.ts:32–33` |
| `2n ** 256n` | uint256 wrap-around | `divergence-loss.ts:241,247` (should be `UINT256_MAX_PLUS_ONE`) |
| `-32005` | RPC rate-limit error code | `rpc.ts:51,54,68` |
| `-32099` | RPC timeout error code | `client.ts:68` |
| `30_000` | Transport timeout ms | `client.ts:32`, `hypersync.ts:38` (defined independently) |
| ~~`"https://hyperliquid.hypersync.xyz"`~~ | ~~HyperSync URL~~ | **FIXED** — `tax-transactions.ts` now imports `DEFAULT_HYPERSYNC_URL` |
| `"YOUR_HYPERSYNC_API_TOKEN"` / `"YOUR_ETHERSCAN_API_KEY"` | Sentinel strings for unconfigured keys | `tax-transactions.ts:1045,1052–1053` |
| `"ProjectX"` | Stale placeholder name in display output | `display/table.ts:83` |

---

## Recommended Refactoring Priorities

Listed by ROI (impact vs. effort):

1. **Extract `persistPositionEntry(pos, openEvent, tokens)`** — eliminates 5 near-identical `upsertPosition` call sites
2. **Extract `paginateHyperSync<T>()`** generic wrapper in `hypersync.ts` — removes ~100 lines
3. **Decompose `getPnLView`** into `resolveEntryData`, `resolveExitData`, `resolveUsdPrices`
4. **Add `toHumanAmount(raw, decimals)`** utility and `TICK_BASE` / `tickToAdjustedPrice` to math module
5. **Split `db/store.ts`** into domain-scoped modules (`positions`, `snapshots`, `tax-transactions`, `caches`, `sync-state`)
6. **Split `tax-transactions.ts`** into `lp-flows.ts`, `hypersync-normaliser.ts`, `explorer-sync.ts`, `eur-enrichment.ts`
7. **Remove or gate the TLS-disable side effect** in `client.ts:9`
