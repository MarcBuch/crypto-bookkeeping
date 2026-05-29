import { Database } from "bun:sqlite";
import { join, resolve } from "path";
import { mkdirSync, existsSync } from "fs";

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

function initSchema(db: Database): void {
  db.exec(`
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
  `);

  // Migration: add entry_liquidity column if it doesn't exist
  const cols = db.prepare("PRAGMA table_info(positions)").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "entry_liquidity")) {
    db.exec("ALTER TABLE positions ADD COLUMN entry_liquidity TEXT");
  }
}
