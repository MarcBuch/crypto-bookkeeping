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
    ]
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
    ]
  );
}

export function getSnapshots(tokenId: string, limit = 50): StoredSnapshot[] {
  const db = getDb();
  return db
    .query(
      "SELECT * FROM snapshots WHERE token_id = ? ORDER BY timestamp DESC LIMIT ?"
    )
    .all(tokenId, limit) as StoredSnapshot[];
}

export function getLatestSnapshot(tokenId: string): StoredSnapshot | null {
  const db = getDb();
  return db
    .query(
      "SELECT * FROM snapshots WHERE token_id = ? ORDER BY timestamp DESC LIMIT 1"
    )
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
       ORDER BY s.token_id`
    )
    .all() as StoredSnapshot[];
}
