import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { join, resolve } from "path";

/**
 * Resolve the database file path.
 *
 * Resolution order:
 *   1. LP_TRACKER_DATA_DIR env var — DB placed at <LP_TRACKER_DATA_DIR>/lp-tracker.db
 *   2. data/lp-tracker.db in the current working directory
 *   3. data/lp-tracker.db three levels up from this file (repo root, for development)
 */
export function resolveDbPath(): string {
  if (process.env.LP_TRACKER_DATA_DIR) {
    return join(resolve(process.env.LP_TRACKER_DATA_DIR), "lp-tracker.db");
  }
  const cwdDataDir = join(process.cwd(), "data");
  if (existsSync(cwdDataDir)) {
    return join(cwdDataDir, "lp-tracker.db");
  }
  // Fallback: repo root relative to packages/core/src/db/schema.ts → ../../../../data
  return join(import.meta.dir, "..", "..", "..", "..", "data", "lp-tracker.db");
}

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    const dbPath = resolveDbPath();
    // Ensure the data directory exists before opening the DB
    const dataDir = dbPath.substring(0, dbPath.lastIndexOf("/"));
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch (err: any) {
      throw new Error(
        `Cannot create data directory at ${dataDir}: ${err.message}\n` +
          `Set LP_TRACKER_DATA_DIR to a writable path.`,
        { cause: err },
      );
    }
    db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    initSchema(db);
  }
  return db;
}

/** Reset the cached DB instance (used in tests). */
export function resetDb(): void {
  db = null;
}

function initSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      token_id TEXT PRIMARY KEY,
      token0 TEXT NOT NULL,
      token1 TEXT NOT NULL,
      token0_symbol TEXT,
      token1_symbol TEXT,
      token0_decimals INTEGER,
      token1_decimals INTEGER,
      fee INTEGER NOT NULL,
      tick_lower INTEGER NOT NULL,
      tick_upper INTEGER NOT NULL,
      entry_sqrt_price_x96 TEXT,
      entry_block INTEGER,
      entry_amount0 TEXT,
      entry_amount1 TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      liquidity TEXT NOT NULL,
      current_sqrt_price_x96 TEXT NOT NULL,
      current_tick INTEGER NOT NULL,
      current_amount0 TEXT NOT NULL,
      current_amount1 TEXT NOT NULL,
      entry_amount0 TEXT NOT NULL,
      entry_amount1 TEXT NOT NULL,
      value_lp REAL NOT NULL,
      value_hold REAL NOT NULL,
      divergence_loss REAL NOT NULL,
      fees0 REAL DEFAULT 0,
      fees1 REAL DEFAULT 0,
      fees_value REAL DEFAULT 0,
      net_pnl REAL DEFAULT 0,
      FOREIGN KEY (token_id) REFERENCES positions(token_id)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_token_id ON snapshots(token_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON snapshots(timestamp);

    CREATE TABLE IF NOT EXISTS tax_transactions (
      id TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      block_number INTEGER,
      time_stamp TEXT,
      from_address TEXT,
      to_address TEXT,
      value TEXT,
      gas_used TEXT,
      gas_price TEXT,
      fee TEXT,
      method_id TEXT,
      function_name TEXT,
      input TEXT,
      contract_address TEXT,
      token_symbol TEXT,
      token_decimal INTEGER,
      token_name TEXT,
      transaction_type TEXT,
      source TEXT NOT NULL,
      is_error INTEGER,
      label TEXT CHECK (label IS NULL OR label IN ('Trade', 'Transfer')),
      incoming_quantity TEXT,
      incoming_asset TEXT,
      outgoing_quantity TEXT,
      outgoing_asset TEXT,
      cost_eur TEXT,
      proceeds_eur TEXT,
      gain_eur TEXT,
      holding_duration_days INTEGER,
      comment TEXT,
      synced_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tax_transactions_hash ON tax_transactions(hash);
    CREATE INDEX IF NOT EXISTS idx_tax_transactions_time_stamp ON tax_transactions(time_stamp);
    CREATE INDEX IF NOT EXISTS idx_tax_transactions_block_number ON tax_transactions(block_number);
    CREATE INDEX IF NOT EXISTS idx_tax_transactions_from_address ON tax_transactions(from_address);
    CREATE INDEX IF NOT EXISTS idx_tax_transactions_to_address ON tax_transactions(to_address);

    CREATE TABLE IF NOT EXISTS tax_sync_state (
      wallet TEXT PRIMARY KEY,
      last_synced_at TEXT NOT NULL,
      last_block_number INTEGER,
      source TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS positions_view_cache (
      token_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pnl_view_cache (
      token_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lp_sync_state (
      wallet TEXT PRIMARY KEY,
      last_synced_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_positions_view_cache_synced_at ON positions_view_cache(synced_at);
    CREATE INDEX IF NOT EXISTS idx_pnl_view_cache_synced_at ON pnl_view_cache(synced_at);
  `);

  // Migration: add entry_liquidity column if it doesn't exist
  const cols = database.prepare("PRAGMA table_info(positions)").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "entry_liquidity")) {
    database.exec("ALTER TABLE positions ADD COLUMN entry_liquidity TEXT");
  }

  const taxTransactionCols = database.prepare("PRAGMA table_info(tax_transactions)").all() as {
    name: string;
    pk: number;
  }[];
  const hashCol = taxTransactionCols.find((c) => c.name === "hash");
  if (!taxTransactionCols.some((c) => c.name === "id") || hashCol?.pk) {
    const idExpression = taxTransactionCols.some((c) => c.name === "id")
      ? "COALESCE(id, hash)"
      : "hash";
    database.exec(`
      CREATE TABLE tax_transactions_new (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        block_number INTEGER,
        time_stamp TEXT,
        from_address TEXT,
        to_address TEXT,
        value TEXT,
        gas_used TEXT,
        gas_price TEXT,
        fee TEXT,
        method_id TEXT,
        function_name TEXT,
        input TEXT,
        contract_address TEXT,
        token_symbol TEXT,
        token_decimal INTEGER,
        token_name TEXT,
        transaction_type TEXT,
        source TEXT NOT NULL,
        is_error INTEGER,
        label TEXT CHECK (label IS NULL OR label IN ('Trade', 'Transfer')),
        incoming_quantity TEXT,
        incoming_asset TEXT,
        outgoing_quantity TEXT,
        outgoing_asset TEXT,
        cost_eur TEXT,
        proceeds_eur TEXT,
        gain_eur TEXT,
        holding_duration_days INTEGER,
        comment TEXT,
        synced_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      INSERT INTO tax_transactions_new
        (id, hash, block_number, time_stamp, from_address, to_address, value, gas_used,
         gas_price, fee, method_id, function_name, input, contract_address, token_symbol,
         token_decimal, token_name, transaction_type, source, is_error, label,
         incoming_quantity, incoming_asset, outgoing_quantity, outgoing_asset, cost_eur,
         proceeds_eur, gain_eur, holding_duration_days, comment, synced_at, created_at,
         updated_at)
      SELECT
        ${idExpression}, hash, block_number, time_stamp, from_address, to_address, value, gas_used,
        gas_price, fee, method_id, function_name, input, contract_address, token_symbol,
        token_decimal, token_name, transaction_type, source, is_error, label,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, comment, synced_at, created_at, updated_at
      FROM tax_transactions;

      DROP TABLE tax_transactions;
      ALTER TABLE tax_transactions_new RENAME TO tax_transactions;
    `);
  }

  const taxLedgerColumns = [
    ["incoming_quantity", "TEXT"],
    ["incoming_asset", "TEXT"],
    ["outgoing_quantity", "TEXT"],
    ["outgoing_asset", "TEXT"],
    ["cost_eur", "TEXT"],
    ["proceeds_eur", "TEXT"],
    ["gain_eur", "TEXT"],
    ["holding_duration_days", "INTEGER"],
  ] as const;
  const migratedTaxTransactionCols = database
    .prepare("PRAGMA table_info(tax_transactions)")
    .all() as {
    name: string;
  }[];
  for (const [name, type] of taxLedgerColumns) {
    if (!migratedTaxTransactionCols.some((c) => c.name === name)) {
      database.exec(`ALTER TABLE tax_transactions ADD COLUMN ${name} ${type}`);
    }
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_tax_transactions_hash ON tax_transactions(hash);
    CREATE INDEX IF NOT EXISTS idx_tax_transactions_time_stamp ON tax_transactions(time_stamp);
    CREATE INDEX IF NOT EXISTS idx_tax_transactions_block_number ON tax_transactions(block_number);
    CREATE INDEX IF NOT EXISTS idx_tax_transactions_from_address ON tax_transactions(from_address);
    CREATE INDEX IF NOT EXISTS idx_tax_transactions_to_address ON tax_transactions(to_address);
  `);
}
