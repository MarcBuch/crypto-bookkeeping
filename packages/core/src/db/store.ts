import { createHash } from "node:crypto";

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

export type TaxTransactionLabel = "Trade" | "Transfer" | null;
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

function assertValidTaxTransactionLabel(label: TaxTransactionLabel | undefined): void {
  if (label !== undefined && label !== null && label !== "Trade" && label !== "Transfer") {
    throw new Error("Tax transaction label must be 'Trade', 'Transfer', or null");
  }
}

export function upsertPosition(position: Omit<StoredPosition, "created_at">): void {
  const db = getDb();
  db.run(
    `INSERT OR REPLACE INTO positions 
     (token_id, token0, token1, token0_symbol, token1_symbol, token0_decimals, token1_decimals, 
      fee, tick_lower, tick_upper, entry_sqrt_price_x96, entry_block, entry_amount0, entry_amount1, entry_liquidity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ],
  );
}

export function getPosition(tokenId: string): StoredPosition | null {
  const db = getDb();
  return db
    .query("SELECT * FROM positions WHERE token_id = ?")
    .get(tokenId) as StoredPosition | null;
}

export function getAllPositions(): StoredPosition[] {
  const db = getDb();
  return db.query("SELECT * FROM positions").all() as StoredPosition[];
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
    .query("SELECT * FROM snapshots WHERE token_id = ? ORDER BY timestamp DESC LIMIT ?")
    .all(tokenId, limit) as StoredSnapshot[];
}

export function getLatestSnapshot(tokenId: string): StoredSnapshot | null {
  const db = getDb();
  return db
    .query("SELECT * FROM snapshots WHERE token_id = ? ORDER BY timestamp DESC LIMIT 1")
    .get(tokenId) as StoredSnapshot | null;
}

export function getAllLatestSnapshots(): StoredSnapshot[] {
  const db = getDb();
  return db
    .query(
      `SELECT s.* FROM snapshots s
       INNER JOIN (
         SELECT token_id, MAX(timestamp) as max_ts
         FROM snapshots GROUP BY token_id
       ) latest ON s.token_id = latest.token_id AND s.timestamp = latest.max_ts
       ORDER BY s.token_id`,
    )
    .all() as StoredSnapshot[];
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
        updated_at = datetime('now')`,
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
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 24);
}

export function getTaxTransaction(id: string): StoredTaxTransaction | null {
  const db = getDb();
  return db
    .query("SELECT * FROM tax_transactions WHERE id = ?")
    .get(id) as StoredTaxTransaction | null;
}

export function listTaxTransactions(
  limit = 100,
  offset = 0,
  label?: TaxTransactionLabelFilter,
): StoredTaxTransaction[] {
  const db = getDb();
  if (label === "unlabeled") {
    return db
      .query(
        `SELECT * FROM tax_transactions
         WHERE label IS NULL
         ORDER BY time_stamp DESC, block_number DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as StoredTaxTransaction[];
  }

  if (label !== undefined) {
    return db
      .query(
        `SELECT * FROM tax_transactions
         WHERE label = ?
         ORDER BY time_stamp DESC, block_number DESC
         LIMIT ? OFFSET ?`,
      )
      .all(label, limit, offset) as StoredTaxTransaction[];
  }

  return db
    .query(
      `SELECT * FROM tax_transactions
       ORDER BY time_stamp DESC, block_number DESC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as StoredTaxTransaction[];
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
    .query(
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
    .all() as Array<{
    id: string;
    asset_in: string | null;
    qty_in: string | null;
    asset_out: string | null;
    qty_out: string | null;
    timestamp: string | null;
  }>;
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
    .query("SELECT * FROM tax_sync_state WHERE wallet = ?")
    .get(wallet) as StoredTaxSyncState | null;
}

export interface StoredLpSyncState {
  wallet: string;
  last_synced_at: string;
}

export function listCachedPositionViews(): Record<string, unknown>[] {
  const db = getDb();
  const rows = db.query("SELECT data FROM positions_view_cache ORDER BY token_id").all() as {
    data: string;
  }[];
  return rows.map((r) => JSON.parse(r.data) as Record<string, unknown>);
}

export function listCachedPnLViews(): Record<string, unknown>[] {
  const db = getDb();
  const rows = db.query("SELECT data FROM pnl_view_cache ORDER BY token_id").all() as {
    data: string;
  }[];
  return rows.map((r) => JSON.parse(r.data) as Record<string, unknown>);
}

export function getPositionsCacheSyncedAt(): string | null {
  const db = getDb();
  const row = db
    .query("SELECT synced_at FROM positions_view_cache ORDER BY synced_at DESC LIMIT 1")
    .get() as { synced_at: string } | null;
  return row?.synced_at ?? null;
}

export function replaceCachedPositionViews(
  rows: Record<string, unknown>[],
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

export function replaceCachedPnLViews(rows: Record<string, unknown>[], syncedAt: string): void {
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
  positionRows: Record<string, unknown>[],
  pnlRows: Record<string, unknown>[],
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
    .query("SELECT * FROM lp_sync_state WHERE wallet = ?")
    .get(wallet) as StoredLpSyncState | null;
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
