import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "..", "..", "data", "lp-tracker.db");

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    initSchema(db);
  }
  return db;
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
  const cols = db.prepare("PRAGMA table_info(positions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "entry_liquidity")) {
    db.exec("ALTER TABLE positions ADD COLUMN entry_liquidity TEXT");
  }
}
