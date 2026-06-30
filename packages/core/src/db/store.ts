import { createHash } from "node:crypto";

import { isRecord } from "../utils/guards.js";
import { getDb } from "./schema";

export interface StoredPosition {
  token_id: string;
  token0: string;
  token1: string;
  token0_symbol: string | null;
  token1_symbol: string | null;
  token0_decimals: number | null;
  token1_decimals: number | null;
  fee: number;
  tick_lower: number;
  tick_upper: number;
  entry_sqrt_price_x96: string | null;
  entry_block: number | null;
  entry_amount0: string | null;
  entry_amount1: string | null;
  entry_liquidity: string | null;
  open_tx?: string | null;
  close_tx?: string | null;
  exit_amount0?: string | null;
  exit_amount1?: string | null;
  fees_collected0?: string | null;
  fees_collected1?: string | null;
  close_block?: number | null;
  close_usd_price0?: number | null;
  close_usd_price1?: number | null;
  exit_sqrt_price_x96?: string | null;
  created_at: string;
}

export interface StoredSnapshot {
  id: number;
  token_id: string;
  timestamp: string;
  liquidity: string;
  current_sqrt_price_x96: string;
  current_tick: number;
  current_amount0: string;
  current_amount1: string;
  entry_amount0: string;
  entry_amount1: string;
  value_lp: number;
  value_hold: number;
  divergence_loss: number;
  fees0: number;
  fees1: number;
  fees_value: number;
  net_pnl: number;
}

export interface StoredHedgeSnapshot {
  id: number;
  token_id: string;
  coin: string;
  szi: string;
  entry_px: number;
  mark_px: number;
  unrealized_pnl: number;
  funding_earned: number;
  liquidation_px: number | null;
  snapshot_at: string;
}

export interface StoredHedgeEvent {
  id: number;
  token_id: string | null;
  coin: string;
  status: "open" | "closed";
  entry_px: number;
  size: number;
  opened_at: string;
  closed_at: string | null;
  close_px: number | null;
  realized_pnl: number | null;
  funding_earned: number | null;
  close_reason: string | null;
  hl_fill_hash: string | null;
  trade_key?: string | null;
  tax_key?: string | null;
  current_szi?: string | null;
  mark_px?: number | null;
  unrealized_pnl?: number | null;
  liquidation_px?: number | null;
  leverage_type?: string | null;
  leverage_value?: number | null;
  updated_at?: string | null;
}

type HedgeEventInsert = Omit<StoredHedgeEvent, "id">;
type HedgeEventUpsert = Omit<StoredHedgeEvent, "id"> & { trade_key: string };
type PreparedHedgeEvent = {
  token_id: string | null;
  coin: string;
  status: "open" | "closed";
  entry_px: number;
  size: number;
  opened_at: string;
  closed_at: string | null;
  close_px: number | null;
  realized_pnl: number | null;
  funding_earned: number | null;
  close_reason: string | null;
  hl_fill_hash: string | null;
  trade_key: string;
  tax_key: string;
  current_szi: string | null;
  mark_px: number | null;
  unrealized_pnl: number | null;
  liquidation_px: number | null;
  leverage_type: string | null;
  leverage_value: number | null;
  updated_at: string;
};

export type TaxTransactionLabel = "Trade" | "Transfer" | "Approval" | "Repay Loan" | null;
export type TaxTransactionLabelFilter = Exclude<TaxTransactionLabel, null> | "unlabeled";

export interface StoredTaxTransaction {
  id: string;
  hash: string;
  block_number: number | null;
  time_stamp: string | null;
  from_address: string | null;
  to_address: string | null;
  value: string | null;
  gas_used: string | null;
  gas_price: string | null;
  fee: string | null;
  method_id: string | null;
  function_name: string | null;
  input: string | null;
  contract_address: string | null;
  token_symbol: string | null;
  token_decimal: number | null;
  token_name: string | null;
  transaction_type: string | null;
  source: string;
  is_error: number | null;
  label: TaxTransactionLabel;
  incoming_quantity: string | null;
  incoming_asset: string | null;
  outgoing_quantity: string | null;
  outgoing_asset: string | null;
  cost_eur: string | null;
  proceeds_eur: string | null;
  gain_eur: string | null;
  holding_duration_days: number | null;
  comment: string | null;
  synced_at: string;
  created_at: string;
  updated_at: string;
}

export type SyncedTaxTransaction = Omit<
  StoredTaxTransaction,
  "label" | "comment" | "created_at" | "updated_at"
>;

export interface TaxTransactionUpdate {
  hash?: string;
  block_number?: number | null;
  time_stamp?: string | null;
  from_address?: string | null;
  to_address?: string | null;
  value?: string | null;
  gas_used?: string | null;
  gas_price?: string | null;
  fee?: string | null;
  method_id?: string | null;
  function_name?: string | null;
  input?: string | null;
  contract_address?: string | null;
  token_symbol?: string | null;
  token_decimal?: number | null;
  token_name?: string | null;
  is_error?: number | null;
  label?: TaxTransactionLabel;
  incoming_quantity?: string | null;
  incoming_asset?: string | null;
  outgoing_quantity?: string | null;
  outgoing_asset?: string | null;
  cost_eur?: string | null;
  proceeds_eur?: string | null;
  gain_eur?: string | null;
  holding_duration_days?: number | null;
  comment?: string | null;
}

const manualOnlyTaxTransactionUpdateFields = [
  "hash",
  "block_number",
  "time_stamp",
  "from_address",
  "to_address",
  "value",
  "gas_used",
  "gas_price",
  "fee",
  "method_id",
  "function_name",
  "input",
  "contract_address",
  "token_symbol",
  "token_decimal",
  "token_name",
  "is_error",
  "incoming_quantity",
  "incoming_asset",
  "outgoing_quantity",
  "outgoing_asset",
  "cost_eur",
  "proceeds_eur",
  "gain_eur",
  "holding_duration_days",
] as const satisfies ReadonlyArray<keyof TaxTransactionUpdate>;

export type ManualTaxTransactionInput = Partial<
  Omit<
    StoredTaxTransaction,
    "source" | "transaction_type" | "synced_at" | "created_at" | "updated_at"
  >
>;

export interface StoredTaxSyncState {
  wallet: string;
  last_synced_at: string;
  last_block_number: number | null;
  source: string;
}

type CacheRow = { data: string };
type SyncedAtRow = { synced_at: string };
type TaxEnrichmentRow = {
  id: string;
  asset_in: string | null;
  qty_in: string | null;
  asset_out: string | null;
  qty_out: string | null;
  timestamp: string | null;
};

function parseCachedView(data: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(data);
  if (!isRecord(parsed)) {
    throw new Error("Cached LP view data must be a JSON object");
  }
  return parsed;
}

function assertValidTaxTransactionLabel(label: TaxTransactionLabel | undefined): void {
  if (
    label !== undefined &&
    label !== null &&
    label !== "Trade" &&
    label !== "Transfer" &&
    label !== "Approval" &&
    label !== "Repay Loan"
  ) {
    throw new Error(
      "Tax transaction label must be 'Trade', 'Transfer', 'Approval', 'Repay Loan', or null",
    );
  }
}

export function upsertPosition(position: Omit<StoredPosition, "created_at">): void {
  const db = getDb();
  db.run(
    `INSERT INTO positions 
     (token_id, token0, token1, token0_symbol, token1_symbol, token0_decimals, token1_decimals, 
      fee, tick_lower, tick_upper, entry_sqrt_price_x96, entry_block, entry_amount0, entry_amount1, entry_liquidity,
      open_tx, close_tx, exit_amount0, exit_amount1, fees_collected0, fees_collected1, close_block, close_usd_price0, close_usd_price1, exit_sqrt_price_x96)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(token_id) DO UPDATE SET
       token0 = excluded.token0,
       token1 = excluded.token1,
       token0_symbol = excluded.token0_symbol,
       token1_symbol = excluded.token1_symbol,
       token0_decimals = excluded.token0_decimals,
       token1_decimals = excluded.token1_decimals,
       fee = excluded.fee,
       tick_lower = excluded.tick_lower,
       tick_upper = excluded.tick_upper,
       entry_sqrt_price_x96 = COALESCE(excluded.entry_sqrt_price_x96, entry_sqrt_price_x96),
       entry_block = COALESCE(excluded.entry_block, entry_block),
       entry_amount0 = COALESCE(excluded.entry_amount0, entry_amount0),
       entry_amount1 = COALESCE(excluded.entry_amount1, entry_amount1),
       entry_liquidity = COALESCE(excluded.entry_liquidity, entry_liquidity),
       open_tx = COALESCE(excluded.open_tx, open_tx),
       close_tx = COALESCE(excluded.close_tx, close_tx),
       exit_amount0 = COALESCE(excluded.exit_amount0, exit_amount0),
       exit_amount1 = COALESCE(excluded.exit_amount1, exit_amount1),
       fees_collected0 = COALESCE(excluded.fees_collected0, fees_collected0),
       fees_collected1 = COALESCE(excluded.fees_collected1, fees_collected1),
       close_block = COALESCE(excluded.close_block, close_block),
       close_usd_price0 = COALESCE(excluded.close_usd_price0, close_usd_price0),
       close_usd_price1 = COALESCE(excluded.close_usd_price1, close_usd_price1),
       exit_sqrt_price_x96 = COALESCE(excluded.exit_sqrt_price_x96, exit_sqrt_price_x96)`,
    [
      position.token_id,
      position.token0,
      position.token1,
      position.token0_symbol,
      position.token1_symbol,
      position.token0_decimals,
      position.token1_decimals,
      position.fee,
      position.tick_lower,
      position.tick_upper,
      position.entry_sqrt_price_x96,
      position.entry_block,
      position.entry_amount0,
      position.entry_amount1,
      position.entry_liquidity,
      position.open_tx ?? null,
      position.close_tx ?? null,
      position.exit_amount0 ?? null,
      position.exit_amount1 ?? null,
      position.fees_collected0 ?? null,
      position.fees_collected1 ?? null,
      position.close_block ?? null,
      position.close_usd_price0 ?? null,
      position.close_usd_price1 ?? null,
      position.exit_sqrt_price_x96 ?? null,
    ],
  );
}

export function getPosition(tokenId: string): StoredPosition | null {
  const db = getDb();
  return db
    .query<StoredPosition, [string]>("SELECT * FROM positions WHERE token_id = ?")
    .get(tokenId);
}

export function getAllPositions(): StoredPosition[] {
  const db = getDb();
  return db.query<StoredPosition, []>("SELECT * FROM positions").all();
}

export function insertSnapshot(snapshot: Omit<StoredSnapshot, "id">): void {
  const db = getDb();
  db.run(
    `INSERT INTO snapshots 
     (token_id, timestamp, liquidity, current_sqrt_price_x96, current_tick,
      current_amount0, current_amount1, entry_amount0, entry_amount1,
      value_lp, value_hold, divergence_loss, fees0, fees1, fees_value, net_pnl)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.token_id,
      snapshot.timestamp,
      snapshot.liquidity,
      snapshot.current_sqrt_price_x96,
      snapshot.current_tick,
      snapshot.current_amount0,
      snapshot.current_amount1,
      snapshot.entry_amount0,
      snapshot.entry_amount1,
      snapshot.value_lp,
      snapshot.value_hold,
      snapshot.divergence_loss,
      snapshot.fees0,
      snapshot.fees1,
      snapshot.fees_value,
      snapshot.net_pnl,
    ],
  );
}

export function getSnapshots(tokenId: string, limit = 50): StoredSnapshot[] {
  const db = getDb();
  return db
    .query<StoredSnapshot, [string, number]>(
      "SELECT * FROM snapshots WHERE token_id = ? ORDER BY timestamp DESC LIMIT ?",
    )
    .all(tokenId, limit);
}

export function getLatestSnapshot(tokenId: string): StoredSnapshot | null {
  const db = getDb();
  return db
    .query<StoredSnapshot, [string]>(
      "SELECT * FROM snapshots WHERE token_id = ? ORDER BY timestamp DESC LIMIT 1",
    )
    .get(tokenId);
}

export function getAllLatestSnapshots(): StoredSnapshot[] {
  const db = getDb();
  return db
    .query<StoredSnapshot, []>(
      `SELECT s.* FROM snapshots s
       INNER JOIN (
          SELECT token_id, MAX(timestamp) as max_ts
         FROM snapshots GROUP BY token_id
       ) latest ON s.token_id = latest.token_id AND s.timestamp = latest.max_ts
       ORDER BY s.token_id`,
    )
    .all();
}

export function upsertSyncedTaxTransaction(transaction: SyncedTaxTransaction): void {
  const db = getDb();
  db.run(
    `INSERT INTO tax_transactions
     (id, hash, block_number, time_stamp, from_address, to_address, value, gas_used, gas_price,
        fee, method_id, function_name, input, contract_address, token_symbol, token_decimal,
        token_name, transaction_type, source, is_error, incoming_quantity, incoming_asset,
        outgoing_quantity, outgoing_asset, cost_eur, proceeds_eur, gain_eur,
        holding_duration_days, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
        hash = excluded.hash,
        block_number = excluded.block_number,
       time_stamp = excluded.time_stamp,
       from_address = excluded.from_address,
       to_address = excluded.to_address,
       value = excluded.value,
       gas_used = excluded.gas_used,
       gas_price = excluded.gas_price,
       fee = excluded.fee,
       method_id = excluded.method_id,
       function_name = excluded.function_name,
       input = excluded.input,
       contract_address = excluded.contract_address,
       token_symbol = excluded.token_symbol,
       token_decimal = excluded.token_decimal,
       token_name = excluded.token_name,
        transaction_type = excluded.transaction_type,
        source = excluded.source,
        is_error = excluded.is_error,
        incoming_quantity = excluded.incoming_quantity,
        incoming_asset = excluded.incoming_asset,
        outgoing_quantity = excluded.outgoing_quantity,
        outgoing_asset = excluded.outgoing_asset,
        synced_at = excluded.synced_at,
        updated_at = datetime('now')
      WHERE tax_transactions.source != 'manual'`,
    [
      transaction.id,
      transaction.hash,
      transaction.block_number,
      transaction.time_stamp,
      transaction.from_address,
      transaction.to_address,
      transaction.value,
      transaction.gas_used,
      transaction.gas_price,
      transaction.fee,
      transaction.method_id,
      transaction.function_name,
      transaction.input,
      transaction.contract_address,
      transaction.token_symbol,
      transaction.token_decimal,
      transaction.token_name,
      transaction.transaction_type,
      transaction.source,
      transaction.is_error,
      transaction.incoming_quantity,
      transaction.incoming_asset,
      transaction.outgoing_quantity,
      transaction.outgoing_asset,
      transaction.cost_eur,
      transaction.proceeds_eur,
      transaction.gain_eur,
      transaction.holding_duration_days,
      transaction.synced_at,
    ],
  );
}

export function createManualTaxTransaction(
  transaction: ManualTaxTransactionInput,
): StoredTaxTransaction {
  assertValidTaxTransactionLabel(transaction.label);

  const db = getDb();
  const syncedAt = new Date().toISOString();
  const hasExplicitId = "id" in transaction;
  const id = hasExplicitId
    ? manualTaxTransactionId(transaction.id ?? "")
    : nextManualTaxTransactionId(
        manualTaxTransactionId(`auto:${manualTaxTransactionHash(transaction)}`),
      );
  const hash = transaction.hash ?? id;

  if (hasExplicitId && getTaxTransaction(id)) {
    throw new Error(`Manual tax transaction already exists: ${id}`);
  }

  db.run(
    `INSERT INTO tax_transactions
     (id, hash, block_number, time_stamp, from_address, to_address, value, gas_used, gas_price,
        fee, method_id, function_name, input, contract_address, token_symbol, token_decimal,
        token_name, transaction_type, source, is_error, label, incoming_quantity, incoming_asset,
        outgoing_quantity, outgoing_asset, cost_eur, proceeds_eur, gain_eur,
        holding_duration_days, comment, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      hash,
      transaction.block_number ?? null,
      transaction.time_stamp ?? null,
      transaction.from_address ?? null,
      transaction.to_address ?? null,
      transaction.value ?? null,
      transaction.gas_used ?? null,
      transaction.gas_price ?? null,
      transaction.fee ?? null,
      transaction.method_id ?? null,
      transaction.function_name ?? null,
      transaction.input ?? null,
      transaction.contract_address ?? null,
      transaction.token_symbol ?? null,
      transaction.token_decimal ?? null,
      transaction.token_name ?? null,
      "manual",
      "manual",
      transaction.is_error ?? null,
      transaction.label ?? null,
      transaction.incoming_quantity ?? null,
      transaction.incoming_asset ?? null,
      transaction.outgoing_quantity ?? null,
      transaction.outgoing_asset ?? null,
      transaction.cost_eur ?? null,
      transaction.proceeds_eur ?? null,
      transaction.gain_eur ?? null,
      transaction.holding_duration_days ?? null,
      transaction.comment ?? null,
      syncedAt,
    ],
  );

  const stored = getTaxTransaction(id);
  if (!stored) throw new Error(`Manual tax transaction was not created: ${id}`);
  return stored;
}

function manualTaxTransactionId(value: string): string {
  const trimmed = value.trim();
  const raw = trimmed.toLowerCase().startsWith("manual:")
    ? trimmed.slice("manual:".length)
    : trimmed;
  const id = raw
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  if (!id) throw new Error("Manual tax transaction id must contain at least one safe character");
  return `manual:${id}`;
}

function nextManualTaxTransactionId(baseId: string): string {
  let id = baseId;
  let suffix = 2;
  while (getTaxTransaction(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function manualTaxTransactionHash(transaction: ManualTaxTransactionInput): string {
  const entries = Object.entries(transaction)
    .filter(([key, value]) => key !== "id" && value !== undefined)
    .toSorted(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 24);
}

export function getTaxTransaction(id: string): StoredTaxTransaction | null {
  const db = getDb();
  return db
    .query<StoredTaxTransaction, [string]>("SELECT * FROM tax_transactions WHERE id = ?")
    .get(id);
}

export function listTaxTransactions(
  limit = 100,
  offset = 0,
  label?: TaxTransactionLabelFilter,
): StoredTaxTransaction[] {
  const db = getDb();
  if (label === "unlabeled") {
    return db
      .query<StoredTaxTransaction, [number, number]>(
        `SELECT * FROM tax_transactions
         WHERE label IS NULL
         ORDER BY time_stamp DESC, block_number DESC
          LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);
  }

  if (label !== undefined) {
    return db
      .query<StoredTaxTransaction, [TaxTransactionLabelFilter, number, number]>(
        `SELECT * FROM tax_transactions
         WHERE label = ?
         ORDER BY time_stamp DESC, block_number DESC
          LIMIT ? OFFSET ?`,
      )
      .all(label, limit, offset);
  }

  return db
    .query<StoredTaxTransaction, [number, number]>(
      `SELECT * FROM tax_transactions
       ORDER BY time_stamp DESC, block_number DESC
        LIMIT ? OFFSET ?`,
    )
      .all(limit, offset);
}

export function countTaxTransactions(label?: TaxTransactionLabelFilter): number {
  const db = getDb();

  if (label === "unlabeled") {
    return db
      .query<{ total: number }, []>("SELECT COUNT(*) AS total FROM tax_transactions WHERE label IS NULL")
      .get()!.total;
  }

  if (label !== undefined) {
    return db
      .query<{ total: number }, [TaxTransactionLabelFilter]>(
        "SELECT COUNT(*) AS total FROM tax_transactions WHERE label = ?",
      )
      .get(label)!.total;
  }

  return db.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM tax_transactions").get()!
    .total;
}

export function listGermanTaxableTransactions(limit = 100, offset = 0): StoredTaxTransaction[] {
  const db = getDb();
  return db
    .query<StoredTaxTransaction, [number, number]>(
      `SELECT * FROM tax_transactions
       WHERE label IS NULL OR label != 'Approval'
       ORDER BY time_stamp DESC, block_number DESC
        LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);
}

export function getTaxTransactionsNeedingGermanTaxReview(
  limit = 100,
  offset = 0,
): StoredTaxTransaction[] {
  const db = getDb();
  return db
    .query<StoredTaxTransaction, [number, number]>(
      `SELECT * FROM tax_transactions
       WHERE label IS NULL
       ORDER BY time_stamp DESC, block_number DESC
        LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);
}

export function updateTaxTransaction(
  id: string,
  update: TaxTransactionUpdate,
): StoredTaxTransaction | null {
  assertValidTaxTransactionLabel(update.label);

  const existing = getTaxTransaction(id);
  if (!existing) return null;

  const hasManualOnlyUpdate = manualOnlyTaxTransactionUpdateFields.some((field) => field in update);
  if (hasManualOnlyUpdate && existing.source !== "manual") {
    throw new Error("Only manual tax transactions can update ledger properties");
  }

  const assignments: string[] = [];
  const params: Array<string | number | null> = [];
  for (const field of manualOnlyTaxTransactionUpdateFields) {
    if (field in update) {
      assignments.push(`${field} = ?`);
      params.push(update[field] ?? null);
    }
  }
  if ("label" in update) {
    assignments.push("label = ?");
    params.push(update.label ?? null);
  }
  if ("comment" in update) {
    assignments.push("comment = ?");
    params.push(update.comment ?? null);
  }
  if (assignments.length === 0) {
    return existing;
  }

  const db = getDb();
  db.run(
    `UPDATE tax_transactions SET ${assignments.join(", ")}, updated_at = datetime('now') WHERE id = ?`,
    [...params, id],
  );
  return getTaxTransaction(id);
}

export function upsertTaxSyncState(syncState: StoredTaxSyncState): void {
  const db = getDb();
  db.run(
    `INSERT INTO tax_sync_state (wallet, last_synced_at, last_block_number, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(wallet) DO UPDATE SET
       last_synced_at = excluded.last_synced_at,
       last_block_number = excluded.last_block_number,
       source = excluded.source`,
    [syncState.wallet, syncState.last_synced_at, syncState.last_block_number, syncState.source],
  );
}

export function getTaxTransactionsNeedingEurEnrichment(): Array<{
  id: string;
  asset_in: string | null;
  qty_in: string | null;
  asset_out: string | null;
  qty_out: string | null;
  timestamp: string | null;
}> {
  const db = getDb();
  return db
    .query<TaxEnrichmentRow, []>(
      `SELECT id,
              incoming_asset  AS asset_in,
              incoming_quantity AS qty_in,
              outgoing_asset  AS asset_out,
              outgoing_quantity AS qty_out,
              time_stamp      AS timestamp
       FROM tax_transactions
        WHERE cost_eur IS NULL AND proceeds_eur IS NULL
        ORDER BY time_stamp ASC NULLS LAST, id ASC`,
    )
    .all();
}

export function updateTaxTransactionEurValues(
  id: string,
  values: { cost_eur: string | null; proceeds_eur: string | null; gain_eur: string | null },
): void {
  const db = getDb();
  db.run(
    `UPDATE tax_transactions SET cost_eur = ?, proceeds_eur = ?, gain_eur = ?, updated_at = datetime('now') WHERE id = ?`,
    [values.cost_eur, values.proceeds_eur, values.gain_eur, id],
  );
}

export function getTaxSyncState(wallet: string): StoredTaxSyncState | null {
  const db = getDb();
  return db
    .query<StoredTaxSyncState, [string]>("SELECT * FROM tax_sync_state WHERE wallet = ?")
    .get(wallet);
}

export interface StoredLpSyncState {
  wallet: string;
  last_synced_at: string;
}

export function listCachedPositionViews(): Record<string, unknown>[] {
  const db = getDb();
  const rows = db
    .query<CacheRow, []>("SELECT data FROM positions_view_cache ORDER BY token_id")
    .all();
  return rows.map((r) => parseCachedView(r.data));
}

export function listCachedPnLViews(): Record<string, unknown>[] {
  const db = getDb();
  const rows = db.query<CacheRow, []>("SELECT data FROM pnl_view_cache ORDER BY token_id").all();
  return rows.map((r) => parseCachedView(r.data));
}

export function getPositionsCacheSyncedAt(): string | null {
  const db = getDb();
  const row = db
    .query<SyncedAtRow, []>(
      "SELECT synced_at FROM positions_view_cache ORDER BY synced_at DESC LIMIT 1",
    )
    .get();
  return row?.synced_at ?? null;
}

export function replaceCachedPositionViews(
  rows: Array<{ tokenId: unknown }>,
  syncedAt: string,
): void {
  const db = getDb();
  db.transaction(() => {
    db.run("DELETE FROM positions_view_cache");
    for (const row of rows) {
      const tokenId = String(row.tokenId);
      db.run("INSERT INTO positions_view_cache (token_id, data, synced_at) VALUES (?, ?, ?)", [
        tokenId,
        JSON.stringify(row),
        syncedAt,
      ]);
    }
  })();
}

export function replaceCachedPnLViews(rows: Array<{ tokenId: unknown }>, syncedAt: string): void {
  const db = getDb();
  db.transaction(() => {
    db.run("DELETE FROM pnl_view_cache");
    for (const row of rows) {
      const tokenId = String(row.tokenId);
      db.run("INSERT INTO pnl_view_cache (token_id, data, synced_at) VALUES (?, ?, ?)", [
        tokenId,
        JSON.stringify(row),
        syncedAt,
      ]);
    }
  })();
}

export function replaceLpCaches(
  positionRows: Array<{ tokenId: unknown }>,
  pnlRows: Array<{ tokenId: unknown }>,
  syncedAt: string,
): void {
  const db = getDb();
  db.transaction(() => {
    db.run("DELETE FROM positions_view_cache");
    for (const row of positionRows) {
      db.run("INSERT INTO positions_view_cache (token_id, data, synced_at) VALUES (?, ?, ?)", [
        String(row.tokenId),
        JSON.stringify(row),
        syncedAt,
      ]);
    }
    db.run("DELETE FROM pnl_view_cache");
    for (const row of pnlRows) {
      db.run("INSERT INTO pnl_view_cache (token_id, data, synced_at) VALUES (?, ?, ?)", [
        String(row.tokenId),
        JSON.stringify(row),
        syncedAt,
      ]);
    }
  })();
}

export function getLpSyncState(wallet: string): StoredLpSyncState | null {
  const db = getDb();
  return db
    .query<StoredLpSyncState, [string]>("SELECT * FROM lp_sync_state WHERE wallet = ?")
    .get(wallet);
}

export function upsertLpSyncState(state: StoredLpSyncState): void {
  const db = getDb();
  db.run(
    `INSERT INTO lp_sync_state (wallet, last_synced_at)
     VALUES (?, ?)
     ON CONFLICT(wallet) DO UPDATE SET last_synced_at = excluded.last_synced_at`,
    [state.wallet, state.last_synced_at],
  );
}

export function upsertPositionViewCache(
  tokenId: string | null,
  data: unknown,
  syncedAt: string,
): void {
  const db = getDb();
  db.run(
    "INSERT OR REPLACE INTO positions_view_cache (token_id, data, synced_at) VALUES (?, ?, ?)",
    [tokenId, JSON.stringify(data), syncedAt],
  );
}

export function upsertPnLViewCache(tokenId: string | null, data: unknown, syncedAt: string): void {
  const db = getDb();
  db.run("INSERT OR REPLACE INTO pnl_view_cache (token_id, data, synced_at) VALUES (?, ?, ?)", [
    tokenId,
    JSON.stringify(data),
    syncedAt,
  ]);
}

export function updateCachedPnLView(tokenId: string, update: Record<string, unknown>): void {
  const db = getDb();
  const existing = db.query<CacheRow, [string]>("SELECT data FROM pnl_view_cache WHERE token_id = ?").get(tokenId);
  if (!existing) {
    return;
  }

  const merged = { ...parseCachedView(existing.data), ...update };
  db.run(
    "UPDATE pnl_view_cache SET data = ? WHERE token_id = ?",
    [JSON.stringify(merged), tokenId],
  );
}

export interface StoredTokenMetadata {
  contract_address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  fetched_at: string;
}

export function insertHedgeSnapshot(
  snapshot: Omit<StoredHedgeSnapshot, "id" | "snapshot_at">,
): void {
  const db = getDb();
  db.run(
    `INSERT INTO hedge_snapshots
     (token_id, coin, szi, entry_px, mark_px, unrealized_pnl, funding_earned, liquidation_px)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.token_id,
      snapshot.coin,
      snapshot.szi,
      snapshot.entry_px,
      snapshot.mark_px,
      snapshot.unrealized_pnl,
      snapshot.funding_earned,
      snapshot.liquidation_px ?? null,
    ],
  );
}

export function listHedgeSnapshots(tokenId: string): StoredHedgeSnapshot[] {
  const db = getDb();
  return db
    .query<StoredHedgeSnapshot, [string]>(
      "SELECT id, token_id, coin, szi, entry_px, mark_px, unrealized_pnl, funding_earned, liquidation_px, snapshot_at FROM hedge_snapshots WHERE token_id = ? ORDER BY snapshot_at DESC",
    )
    .all(tokenId);
}

export function getEarliestHedgeSnapshot(
  token_id: string,
  coin: string,
): StoredHedgeSnapshot | null {
  const db = getDb();
  return db
    .query<StoredHedgeSnapshot, [string, string]>(
      "SELECT id, token_id, coin, szi, entry_px, mark_px, unrealized_pnl, funding_earned, liquidation_px, snapshot_at FROM hedge_snapshots WHERE token_id = ? AND coin = ? ORDER BY snapshot_at ASC LIMIT 1",
    )
    .get(token_id, coin);
}

export function insertHedgeEvent(event: Omit<StoredHedgeEvent, "id">): StoredHedgeEvent {
  const preparedEvent = prepareHedgeEventForWrite(event);
  const db = getDb();
  db.run(
    `INSERT INTO hedge_events
     (token_id, coin, status, entry_px, size, opened_at, closed_at, close_px, realized_pnl, funding_earned, close_reason, hl_fill_hash, trade_key, tax_key, current_szi, mark_px, unrealized_pnl, liquidation_px, leverage_type, leverage_value, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      preparedEvent.token_id,
      preparedEvent.coin,
      preparedEvent.status,
      preparedEvent.entry_px,
      preparedEvent.size,
      preparedEvent.opened_at,
      preparedEvent.closed_at,
      preparedEvent.close_px,
      preparedEvent.realized_pnl,
      preparedEvent.funding_earned,
      preparedEvent.close_reason,
      preparedEvent.hl_fill_hash,
      preparedEvent.trade_key,
      preparedEvent.tax_key,
      preparedEvent.current_szi,
      preparedEvent.mark_px,
      preparedEvent.unrealized_pnl,
      preparedEvent.liquidation_px,
      preparedEvent.leverage_type,
      preparedEvent.leverage_value,
      preparedEvent.updated_at,
    ],
  );

  const inserted = db
    .query<StoredHedgeEvent, []>("SELECT * FROM hedge_events WHERE id = last_insert_rowid()")
    .get();
  if (!inserted) {
    throw new Error("Inserted hedge event could not be reloaded");
  }
  return inserted;
}

function defaultHedgeTradeKey(event: Pick<
  HedgeEventInsert,
  "token_id" | "coin" | "hl_fill_hash" | "opened_at" | "entry_px" | "size"
>): string {
  if (event.hl_fill_hash) {
    return `trade:fill:${event.coin}:${event.hl_fill_hash}`;
  }
  return `trade:legacy:${event.token_id ?? "unassigned"}:${event.coin}:${event.opened_at}:${String(event.entry_px)}:${String(event.size)}`;
}

function defaultHedgeTaxKey(event: Pick<
  HedgeEventInsert,
  "token_id" | "coin" | "hl_fill_hash" | "opened_at" | "entry_px" | "size"
>): string {
  if (event.hl_fill_hash) {
    return `tax:legacy:${event.token_id ?? "unassigned"}:${event.coin}:${event.hl_fill_hash}`;
  }
  return `tax:legacy:${event.token_id ?? "unassigned"}:${event.coin}:${event.opened_at}:${String(event.entry_px)}:${String(event.size)}`;
}

function normalizeClosedHedgeIdentity(event: StoredHedgeEvent): StoredHedgeEvent {
  if (!event.hl_fill_hash) {
    return event;
  }

  const normalizedTradeKey = defaultHedgeTradeKey({
    token_id: event.token_id,
    coin: event.coin,
    hl_fill_hash: event.hl_fill_hash,
    opened_at: event.opened_at,
    entry_px: event.entry_px,
    size: event.size,
  });
  const backfillTaxKey = defaultHedgeTaxKey({
    token_id: event.token_id,
    coin: event.coin,
    hl_fill_hash: event.hl_fill_hash,
    opened_at: event.opened_at,
    entry_px: event.entry_px,
    size: event.size,
  });

  if (event.trade_key === normalizedTradeKey && event.tax_key != null) {
    return event;
  }

  const db = getDb();
  db.run(
    `UPDATE hedge_events
     SET trade_key = ?, tax_key = COALESCE(tax_key, ?), updated_at = COALESCE(updated_at, closed_at, opened_at, datetime('now'))
     WHERE id = ?`,
    [normalizedTradeKey, backfillTaxKey, event.id],
  );

  const normalized = getHedgeEvent(event.id);
  if (!normalized) {
    throw new Error(`Normalized hedge event could not be reloaded: ${event.id}`);
  }
  return normalized;
}

function prepareHedgeEventForWrite(event: HedgeEventInsert): PreparedHedgeEvent {
  const trade_key = event.trade_key ?? defaultHedgeTradeKey(event);
  return {
    token_id: event.token_id ?? null,
    coin: event.coin,
    status: event.status,
    entry_px: event.entry_px,
    size: event.size,
    opened_at: event.opened_at,
    closed_at: event.closed_at ?? null,
    close_px: event.close_px ?? null,
    realized_pnl: event.realized_pnl ?? null,
    funding_earned: event.funding_earned ?? null,
    close_reason: event.close_reason ?? null,
    hl_fill_hash: event.hl_fill_hash ?? null,
    trade_key,
    tax_key: event.tax_key ?? defaultHedgeTaxKey(event),
    current_szi: event.current_szi ?? null,
    mark_px: event.mark_px ?? null,
    unrealized_pnl: event.unrealized_pnl ?? null,
    liquidation_px: event.liquidation_px ?? null,
    leverage_type: event.leverage_type ?? null,
    leverage_value: event.leverage_value ?? null,
    updated_at: event.updated_at ?? event.closed_at ?? event.opened_at,
  };
}

function overwriteHedgeEvent(existing: StoredHedgeEvent, preparedEvent: PreparedHedgeEvent): StoredHedgeEvent {
  const existingTaxKey = existing.tax_key ?? null;
  const shouldReplaceTaxKey =
    existingTaxKey == null ||
    (preparedEvent.status === "open" &&
      preparedEvent.trade_key.startsWith("trade:hl:") &&
      !preparedEvent.trade_key.includes(":active:") &&
      existingTaxKey.startsWith("tax:hl:active:"));

  const db = getDb();
  db.run(
    `UPDATE hedge_events
     SET token_id = ?, coin = ?, status = ?, entry_px = ?, size = ?, opened_at = ?, closed_at = ?, close_px = ?, realized_pnl = ?, funding_earned = ?, close_reason = ?, hl_fill_hash = ?, trade_key = ?, tax_key = ?, current_szi = ?, mark_px = ?, unrealized_pnl = ?, liquidation_px = ?, leverage_type = ?, leverage_value = ?, updated_at = ?
     WHERE id = ?`,
    [
      existing.token_id ?? preparedEvent.token_id,
      preparedEvent.coin,
      preparedEvent.status,
      preparedEvent.entry_px,
      preparedEvent.size,
      preparedEvent.opened_at,
      preparedEvent.closed_at,
      preparedEvent.close_px,
      preparedEvent.realized_pnl,
      preparedEvent.funding_earned,
      preparedEvent.close_reason,
      preparedEvent.hl_fill_hash,
      preparedEvent.trade_key,
      shouldReplaceTaxKey ? preparedEvent.tax_key : existingTaxKey,
      preparedEvent.current_szi,
      preparedEvent.mark_px,
      preparedEvent.unrealized_pnl,
      preparedEvent.liquidation_px,
      preparedEvent.leverage_type,
      preparedEvent.leverage_value,
      preparedEvent.updated_at,
      existing.id,
    ],
  );

  const updated = getHedgeEvent(existing.id);
  if (!updated) {
    throw new Error(`Updated hedge event could not be reloaded: ${existing.id}`);
  }
  return updated;
}

function reconcileClosedHedgeEventByFillHash(params: {
  authoritativeClosedEvent: StoredHedgeEvent;
  incomingTokenId: string | null;
  coin: string;
  cutoffClosedAt: string;
}): StoredHedgeEvent {
  const db = getDb();
  let authoritativeClosedEvent = params.authoritativeClosedEvent;
  let effectiveTokenId = authoritativeClosedEvent.token_id ?? params.incomingTokenId;

  if (authoritativeClosedEvent.token_id == null && params.incomingTokenId != null) {
    db.run(
      `UPDATE hedge_events
       SET token_id = ?, updated_at = COALESCE(updated_at, closed_at, opened_at, datetime('now'))
       WHERE id = ? AND token_id IS NULL`,
      [params.incomingTokenId, authoritativeClosedEvent.id],
    );

    const reloaded = getHedgeEvent(authoritativeClosedEvent.id);
    if (!reloaded) {
      throw new Error(`Reconciled hedge event could not be reloaded: ${authoritativeClosedEvent.id}`);
    }
    authoritativeClosedEvent = reloaded;
    effectiveTokenId = authoritativeClosedEvent.token_id ?? params.incomingTokenId;
  }

  const staleOpenCutoff = authoritativeClosedEvent.closed_at ?? params.cutoffClosedAt;
  const deleteStaleOpenRows = (tokenId: string | null): void => {
    db.run(
      `DELETE FROM hedge_events
       WHERE token_id IS ?
         AND coin = ?
         AND status = 'open'
         AND opened_at < ?
         AND id != ?`,
      [tokenId, params.coin, staleOpenCutoff, authoritativeClosedEvent.id],
    );
  };

  deleteStaleOpenRows(effectiveTokenId);
  if (effectiveTokenId != null) {
    deleteStaleOpenRows(null);
  }

  return normalizeClosedHedgeIdentity(authoritativeClosedEvent);
}

export function closeHedgeEvent(params: {
  token_id: string | null;
  coin: string;
  closed_at: string;
  close_px: number;
  realized_pnl: number;
  funding_earned: number | null;
  close_reason: string;
  hl_fill_hash: string;
}): StoredHedgeEvent | null {
  const db = getDb();

  // Check if this hl_fill_hash already exists (idempotency)
  const existing = db
    .query<StoredHedgeEvent, [string]>("SELECT * FROM hedge_events WHERE hl_fill_hash = ?")
    .get(params.hl_fill_hash);

  if (existing) {
    return reconcileClosedHedgeEventByFillHash({
      authoritativeClosedEvent: existing,
      incomingTokenId: params.token_id,
      coin: params.coin,
      cutoffClosedAt: params.closed_at,
    });
  }

  // Find the open event for this token_id and coin
  const openEvent = db
    .query<StoredHedgeEvent, [string | null, string]>(
      "SELECT * FROM hedge_events WHERE token_id IS ? AND coin = ? AND status = 'open'",
    )
    .get(params.token_id, params.coin);

  if (!openEvent) {
    return null;
  }

  const tradeKey = defaultHedgeTradeKey({
    token_id: openEvent.token_id,
    coin: openEvent.coin,
    hl_fill_hash: params.hl_fill_hash,
    opened_at: openEvent.opened_at,
    entry_px: openEvent.entry_px,
    size: openEvent.size,
  });
  const fallbackTaxKey = defaultHedgeTaxKey({
    token_id: openEvent.token_id,
    coin: openEvent.coin,
    hl_fill_hash: params.hl_fill_hash,
    opened_at: openEvent.opened_at,
    entry_px: openEvent.entry_px,
    size: openEvent.size,
  });

  // Update the open event to closed
  db.run(
    `UPDATE hedge_events
     SET status = 'closed', closed_at = ?, close_px = ?, realized_pnl = ?, funding_earned = ?, close_reason = ?, hl_fill_hash = ?, trade_key = ?
        , tax_key = COALESCE(tax_key, ?)
         , updated_at = ?
       WHERE id = ?`,
    [
      params.closed_at,
      params.close_px,
      params.realized_pnl,
      params.funding_earned,
      params.close_reason,
      params.hl_fill_hash,
      tradeKey,
      fallbackTaxKey,
      params.closed_at,
      openEvent.id,
    ],
  );

  const updated = db
    .query<StoredHedgeEvent, [number]>("SELECT * FROM hedge_events WHERE id = ?")
    .get(openEvent.id);
  if (!updated) {
    throw new Error(`Closed hedge event could not be reloaded: ${openEvent.id}`);
  }
  return normalizeClosedHedgeIdentity(updated);
}

export function getOpenHedgeEvent(token_id: string, coin: string): StoredHedgeEvent | null {
  const db = getDb();
  return db
    .query<StoredHedgeEvent, [string, string]>(
      "SELECT * FROM hedge_events WHERE token_id IS ? AND coin = ? AND status = 'open'",
    )
    .get(token_id, coin);
}

export function getHedgeEvents(token_id: string): StoredHedgeEvent[] {
  const db = getDb();
  return db
    .query<StoredHedgeEvent, [string]>(
      "SELECT * FROM hedge_events WHERE token_id = ? ORDER BY opened_at DESC",
    )
    .all(token_id);
}

export function getAllClosedHedgeEvents(): StoredHedgeEvent[] {
  const db = getDb();
  return db
    .query<StoredHedgeEvent, []>(
      `SELECT * FROM hedge_events WHERE status = 'closed' ORDER BY closed_at ASC NULLS LAST, id ASC`,
    )
    .all();
}

export function getHedgeEvent(id: number): StoredHedgeEvent | null {
  const db = getDb();
  return db.query<StoredHedgeEvent, [number]>("SELECT * FROM hedge_events WHERE id = ?").get(id);
}

export function getHedgeEventByTradeKey(tradeKey: string): StoredHedgeEvent | null {
  const db = getDb();
  return db
    .query<StoredHedgeEvent, [string]>("SELECT * FROM hedge_events WHERE trade_key = ?")
    .get(tradeKey);
}

export function listHedgeEvents(): StoredHedgeEvent[] {
  const db = getDb();
  return db
    .query<StoredHedgeEvent, []>(
      "SELECT * FROM hedge_events ORDER BY opened_at DESC, id DESC",
    )
    .all();
}

export function listUnassignedHedgeEvents(): StoredHedgeEvent[] {
  const db = getDb();
  return db
    .query<StoredHedgeEvent, []>(
      "SELECT * FROM hedge_events WHERE token_id IS NULL ORDER BY opened_at DESC, id DESC",
    )
    .all();
}

export function assignHedgeEvent(id: number, tokenId: string | null): StoredHedgeEvent | null {
  const db = getDb();
  db.run("UPDATE hedge_events SET token_id = ?, updated_at = datetime('now') WHERE id = ?", [
    tokenId,
    id,
  ]);
  return getHedgeEvent(id);
}

export function upsertHedgeEventByTradeKey(event: HedgeEventUpsert): StoredHedgeEvent {
  const preparedEvent = prepareHedgeEventForWrite(event);
  const db = getDb();

  if (preparedEvent.hl_fill_hash) {
    const existingByFillHash = db
      .query<StoredHedgeEvent, [string]>("SELECT * FROM hedge_events WHERE hl_fill_hash = ?")
      .get(preparedEvent.hl_fill_hash);
    if (existingByFillHash) {
      return reconcileClosedHedgeEventByFillHash({
        authoritativeClosedEvent: overwriteHedgeEvent(existingByFillHash, preparedEvent),
        incomingTokenId: preparedEvent.token_id,
        coin: preparedEvent.coin,
        cutoffClosedAt: preparedEvent.closed_at ?? preparedEvent.updated_at,
      });
    }
  }

  if (preparedEvent.status === "closed") {
    const existingOpenCandidate = db
      .query<StoredHedgeEvent, [string, string]>(
        `SELECT * FROM hedge_events
         WHERE coin = ? AND status = 'open' AND opened_at < ?
         ORDER BY opened_at DESC, id DESC
         LIMIT 1`,
      )
      .get(preparedEvent.coin, preparedEvent.closed_at ?? preparedEvent.updated_at);

    if (existingOpenCandidate) {
      return normalizeClosedHedgeIdentity(overwriteHedgeEvent(existingOpenCandidate, preparedEvent));
    }
  }

  if (preparedEvent.status === "open") {
    const existingOpenCandidate = db
      .query<StoredHedgeEvent, [string]>(
        `SELECT * FROM hedge_events
         WHERE coin = ? AND status = 'open'
         ORDER BY opened_at DESC, id DESC
         LIMIT 1`,
      )
      .get(preparedEvent.coin);

    if (existingOpenCandidate && existingOpenCandidate.trade_key !== preparedEvent.trade_key) {
      return overwriteHedgeEvent(existingOpenCandidate, preparedEvent);
    }
  }

  db.run(
    `INSERT INTO hedge_events
     (token_id, coin, status, entry_px, size, opened_at, closed_at, close_px, realized_pnl, funding_earned, close_reason, hl_fill_hash, trade_key, tax_key, current_szi, mark_px, unrealized_pnl, liquidation_px, leverage_type, leverage_value, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(trade_key) DO UPDATE SET
        token_id = COALESCE(hedge_events.token_id, excluded.token_id),
        coin = excluded.coin,
        status = excluded.status,
        entry_px = excluded.entry_px,
       size = excluded.size,
       opened_at = excluded.opened_at,
       closed_at = excluded.closed_at,
       close_px = excluded.close_px,
       realized_pnl = excluded.realized_pnl,
       funding_earned = excluded.funding_earned,
       close_reason = excluded.close_reason,
       hl_fill_hash = excluded.hl_fill_hash,
       tax_key = COALESCE(hedge_events.tax_key, excluded.tax_key),
       current_szi = excluded.current_szi,
       mark_px = excluded.mark_px,
       unrealized_pnl = excluded.unrealized_pnl,
       liquidation_px = excluded.liquidation_px,
       leverage_type = excluded.leverage_type,
       leverage_value = excluded.leverage_value,
       updated_at = excluded.updated_at`,
    [
      preparedEvent.token_id,
      preparedEvent.coin,
      preparedEvent.status,
      preparedEvent.entry_px,
      preparedEvent.size,
      preparedEvent.opened_at,
      preparedEvent.closed_at,
      preparedEvent.close_px,
      preparedEvent.realized_pnl,
      preparedEvent.funding_earned,
      preparedEvent.close_reason,
      preparedEvent.hl_fill_hash,
      preparedEvent.trade_key,
      preparedEvent.tax_key,
      preparedEvent.current_szi,
      preparedEvent.mark_px,
      preparedEvent.unrealized_pnl,
      preparedEvent.liquidation_px,
      preparedEvent.leverage_type,
      preparedEvent.leverage_value,
      preparedEvent.updated_at,
    ],
  );

  const stored = getHedgeEventByTradeKey(preparedEvent.trade_key);
  if (!stored) {
    throw new Error(`Upserted hedge event could not be reloaded: ${preparedEvent.trade_key}`);
  }
  return stored;
}

export function upsertTokenMetadata(metadata: StoredTokenMetadata): void {
  const db = getDb();
  const address = metadata.contract_address.toLowerCase();
  db.run(
    `INSERT OR REPLACE INTO token_metadata (contract_address, symbol, name, decimals, fetched_at)
     VALUES (?, ?, ?, ?, ?)`,
    [address, metadata.symbol, metadata.name, metadata.decimals, metadata.fetched_at],
  );
}

export function getTokenMetadata(contractAddress: string): StoredTokenMetadata | null {
  const db = getDb();
  return db
    .query<StoredTokenMetadata, [string]>("SELECT * FROM token_metadata WHERE contract_address = ?")
    .get(contractAddress.toLowerCase());
}
