import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { join, resolve } from "path";

import { getErrorMessage } from "../utils/guards.js";

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
    } catch (err: unknown) {
      throw new Error(
        `Cannot create data directory at ${dataDir}: ${getErrorMessage(err)}\n` +
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

export function initSchema(database: Database): void {
  const taxLabelCheckConstraint = "label IS NULL OR label IN ('Trade', 'Transfer', 'Approval')";
  const hedgeTradeKeyBackfillSql = `CASE
    WHEN hl_fill_hash IS NOT NULL THEN 'trade:fill:' || coin || ':' || hl_fill_hash
    ELSE 'trade:legacy:' || COALESCE(token_id, 'unassigned') || ':' || coin || ':' || opened_at || ':' || printf('%.17g', entry_px) || ':' || printf('%.17g', size) || ':row:' || id
  END`;
  const hedgeTaxKeyBackfillSql = `CASE
    WHEN hl_fill_hash IS NOT NULL THEN 'tax:legacy:' || COALESCE(token_id, 'unassigned') || ':' || coin || ':' || hl_fill_hash
    ELSE 'tax:legacy:' || COALESCE(token_id, 'unassigned') || ':' || coin || ':' || opened_at || ':' || printf('%.17g', entry_px) || ':' || printf('%.17g', size) || ':row:' || id
  END`;

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
      label TEXT CHECK (${taxLabelCheckConstraint}),
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

    CREATE TABLE IF NOT EXISTS token_metadata (
      contract_address TEXT PRIMARY KEY,
      symbol TEXT,
      name TEXT,
      decimals INTEGER,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hedge_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL,
      coin TEXT NOT NULL,
      szi TEXT NOT NULL,
      entry_px REAL NOT NULL,
      mark_px REAL NOT NULL,
      unrealized_pnl REAL NOT NULL,
      funding_earned REAL NOT NULL,
      liquidation_px REAL,
      snapshot_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_hedge_snapshots_token_id ON hedge_snapshots(token_id);

    CREATE TABLE IF NOT EXISTS hedge_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT,
      coin TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      entry_px REAL NOT NULL,
      size REAL NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      close_px REAL,
      realized_pnl REAL,
      funding_earned REAL,
      close_reason TEXT,
      hl_fill_hash TEXT UNIQUE,
      trade_key TEXT UNIQUE,
      tax_key TEXT,
      current_szi TEXT,
      mark_px REAL,
      unrealized_pnl REAL,
      liquidation_px REAL,
      leverage_type TEXT,
      leverage_value REAL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_hedge_events_token_id ON hedge_events(token_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hedge_events_one_open ON hedge_events(COALESCE(token_id, '__unassigned__'), coin) WHERE status = 'open';
  `);

  // Migration: add entry_liquidity column if it doesn't exist
  const cols = database.prepare<{ name: string }, []>("PRAGMA table_info(positions)").all();
  if (!cols.some((c) => c.name === "entry_liquidity")) {
    database.exec("ALTER TABLE positions ADD COLUMN entry_liquidity TEXT");
  }

  // Migration: add transaction discovery columns (open_tx, close_tx, exit amounts, fees, close_block)
  const positionCols = database.prepare<{ name: string }, []>("PRAGMA table_info(positions)").all();

  if (!positionCols.some((c) => c.name === "open_tx")) {
    database.exec("ALTER TABLE positions ADD COLUMN open_tx TEXT");
  }

  if (!positionCols.some((c) => c.name === "close_tx")) {
    database.exec("ALTER TABLE positions ADD COLUMN close_tx TEXT");
  }

  if (!positionCols.some((c) => c.name === "exit_amount0")) {
    database.exec("ALTER TABLE positions ADD COLUMN exit_amount0 TEXT");
  }

  if (!positionCols.some((c) => c.name === "exit_amount1")) {
    database.exec("ALTER TABLE positions ADD COLUMN exit_amount1 TEXT");
  }

  if (!positionCols.some((c) => c.name === "fees_collected0")) {
    database.exec("ALTER TABLE positions ADD COLUMN fees_collected0 TEXT");
  }

  if (!positionCols.some((c) => c.name === "fees_collected1")) {
    database.exec("ALTER TABLE positions ADD COLUMN fees_collected1 TEXT");
  }

  if (!positionCols.some((c) => c.name === "close_block")) {
    database.exec("ALTER TABLE positions ADD COLUMN close_block INTEGER");
  }

  if (!positionCols.some((c) => c.name === "close_usd_price0")) {
    database.exec("ALTER TABLE positions ADD COLUMN close_usd_price0 REAL");
  }

  if (!positionCols.some((c) => c.name === "close_usd_price1")) {
    database.exec("ALTER TABLE positions ADD COLUMN close_usd_price1 REAL");
  }

  if (!positionCols.some((c) => c.name === "exit_sqrt_price_x96")) {
    database.exec("ALTER TABLE positions ADD COLUMN exit_sqrt_price_x96 TEXT");
  }

  const taxTransactionCols = database
    .prepare<{ name: string; pk: number }, []>("PRAGMA table_info(tax_transactions)")
    .all();
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
        label TEXT CHECK (${taxLabelCheckConstraint}),
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
    .prepare<{ name: string }, []>("PRAGMA table_info(tax_transactions)")
    .all();
  for (const [name, type] of taxLedgerColumns) {
    if (!migratedTaxTransactionCols.some((c) => c.name === name)) {
      database.exec(`ALTER TABLE tax_transactions ADD COLUMN ${name} ${type}`);
    }
  }

  const createTableSqlRow = database
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tax_transactions'",
    )
    .get();
  const needsApprovalLabelMigration =
    createTableSqlRow?.sql.includes("label IN ('Trade', 'Transfer')") ?? false;

  if (needsApprovalLabelMigration) {
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
        label TEXT CHECK (${taxLabelCheckConstraint}),
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
        id, hash, block_number, time_stamp, from_address, to_address, value, gas_used,
        gas_price, fee, method_id, function_name, input, contract_address, token_symbol,
        token_decimal, token_name, transaction_type, source, is_error, label,
        incoming_quantity, incoming_asset, outgoing_quantity, outgoing_asset, cost_eur,
        proceeds_eur, gain_eur, holding_duration_days, comment, synced_at, created_at,
        updated_at
      FROM tax_transactions;

      DROP TABLE tax_transactions;
      ALTER TABLE tax_transactions_new RENAME TO tax_transactions;
    `);
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_tax_transactions_hash ON tax_transactions(hash);
    CREATE INDEX IF NOT EXISTS idx_tax_transactions_time_stamp ON tax_transactions(time_stamp);
    CREATE INDEX IF NOT EXISTS idx_tax_transactions_block_number ON tax_transactions(block_number);
    CREATE INDEX IF NOT EXISTS idx_tax_transactions_from_address ON tax_transactions(from_address);
    CREATE INDEX IF NOT EXISTS idx_tax_transactions_to_address ON tax_transactions(to_address);
  `);

  const hedgeEventCols = database
    .prepare<{ name: string; notnull: number }, []>("PRAGMA table_info(hedge_events)")
    .all();
  const tokenIdColumn = hedgeEventCols.find((column) => column.name === "token_id");
  const needsHedgeEventRebuild = tokenIdColumn?.notnull === 1;

  if (needsHedgeEventRebuild) {
    database.exec(`
      DROP INDEX IF EXISTS idx_hedge_events_token_id;
      DROP INDEX IF EXISTS idx_hedge_events_one_open;
      DROP INDEX IF EXISTS idx_hedge_events_trade_key;

      CREATE TABLE hedge_events_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id TEXT,
        coin TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        entry_px REAL NOT NULL,
        size REAL NOT NULL,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        close_px REAL,
        realized_pnl REAL,
        funding_earned REAL,
        close_reason TEXT,
        hl_fill_hash TEXT UNIQUE,
        trade_key TEXT UNIQUE,
        tax_key TEXT,
        current_szi TEXT,
        mark_px REAL,
        unrealized_pnl REAL,
        liquidation_px REAL,
        leverage_type TEXT,
        leverage_value REAL,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      INSERT INTO hedge_events_new (
        id,
        token_id,
        coin,
        status,
        entry_px,
        size,
        opened_at,
        closed_at,
        close_px,
        realized_pnl,
        funding_earned,
        close_reason,
        hl_fill_hash,
        trade_key,
        tax_key,
        current_szi,
        mark_px,
        unrealized_pnl,
        liquidation_px,
        leverage_type,
        leverage_value,
        updated_at
      )
      SELECT
        id,
        token_id,
        coin,
        status,
        entry_px,
        size,
        opened_at,
        closed_at,
        close_px,
        realized_pnl,
        funding_earned,
        close_reason,
        hl_fill_hash,
        ${hedgeTradeKeyBackfillSql},
        ${hedgeTaxKeyBackfillSql},
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        COALESCE(closed_at, opened_at, datetime('now'))
      FROM hedge_events;

      DROP TABLE hedge_events;
      ALTER TABLE hedge_events_new RENAME TO hedge_events;
    `);
  }

  const migratedHedgeEventCols = database
    .prepare<{ name: string }, []>("PRAGMA table_info(hedge_events)")
    .all();
  const hedgeEventOptionalColumns = [
    ["trade_key", "TEXT"],
    ["tax_key", "TEXT"],
    ["current_szi", "TEXT"],
    ["mark_px", "REAL"],
    ["unrealized_pnl", "REAL"],
    ["liquidation_px", "REAL"],
    ["leverage_type", "TEXT"],
    ["leverage_value", "REAL"],
    ["updated_at", "TEXT"],
  ] as const;

  for (const [name, type] of hedgeEventOptionalColumns) {
    if (!migratedHedgeEventCols.some((column) => column.name === name)) {
      database.exec(`ALTER TABLE hedge_events ADD COLUMN ${name} ${type}`);
    }
  }

  database.exec(`
    UPDATE hedge_events
    SET trade_key = ${hedgeTradeKeyBackfillSql}
    WHERE trade_key IS NULL
      OR (hl_fill_hash IS NOT NULL AND trade_key != ${hedgeTradeKeyBackfillSql})
      OR (
        hl_fill_hash IS NULL
        AND trade_key IN (
          SELECT trade_key
          FROM hedge_events
          WHERE hl_fill_hash IS NULL AND trade_key IS NOT NULL
          GROUP BY trade_key
          HAVING COUNT(*) > 1
        )
      );

    UPDATE hedge_events
    SET tax_key = ${hedgeTaxKeyBackfillSql}
    WHERE tax_key IS NULL;

    UPDATE hedge_events
    SET updated_at = COALESCE(updated_at, closed_at, opened_at, datetime('now'))
    WHERE updated_at IS NULL;

    DROP INDEX IF EXISTS idx_hedge_events_one_open;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hedge_events_one_open
    ON hedge_events(COALESCE(token_id, '__unassigned__'), coin)
    WHERE status = 'open';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_hedge_events_trade_key
    ON hedge_events(trade_key);

    CREATE INDEX IF NOT EXISTS idx_hedge_events_token_id ON hedge_events(token_id);
  `);
}
