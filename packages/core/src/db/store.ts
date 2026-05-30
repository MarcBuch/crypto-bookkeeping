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
  label?: TaxTransactionLabel;
  comment?: string | null;
}

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
       token_name, transaction_type, source, is_error, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      transaction.synced_at,
    ],
  );
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

  const assignments: string[] = [];
  const params: (string | null)[] = [];
  if ("label" in update) {
    assignments.push("label = ?");
    params.push(update.label ?? null);
  }
  if ("comment" in update) {
    assignments.push("comment = ?");
    params.push(update.comment ?? null);
  }
  if (assignments.length === 0) {
    return getTaxTransaction(id);
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

export function getTaxSyncState(wallet: string): StoredTaxSyncState | null {
  const db = getDb();
  return db
    .query("SELECT * FROM tax_sync_state WHERE wallet = ?")
    .get(wallet) as StoredTaxSyncState | null;
}
