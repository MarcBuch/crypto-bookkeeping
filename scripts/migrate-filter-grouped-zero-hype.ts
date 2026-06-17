import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

function resolveDbPath(): string {
  if (process.env.LP_TRACKER_DATA_DIR) {
    return join(resolve(process.env.LP_TRACKER_DATA_DIR), "lp-tracker.db");
  }

  const cwdDataDir = join(process.cwd(), "data");
  if (existsSync(cwdDataDir)) {
    return join(cwdDataDir, "lp-tracker.db");
  }

  return join(import.meta.dir, "..", "data", "lp-tracker.db");
}

const dryRun = process.argv.includes("--dry-run");
const dbPath = resolveDbPath();

if (!existsSync(dbPath)) {
  throw new Error(`Database not found at ${dbPath}`);
}

const db = new Database(dbPath);

const whereClause = `
  source = 'hypersync'
  AND transaction_type = 'txlist'
  AND token_symbol IS NULL
  AND value = '0'
  AND EXISTS (
    SELECT 1
    FROM tax_transactions token_row
    WHERE token_row.hash = tax_transactions.hash
      AND token_row.id <> tax_transactions.id
      AND token_row.source = 'hypersync'
      AND token_row.transaction_type IN ('tokentx', 'tokennfttx')
  )
`;

const wrappersBefore = db
  .query(`SELECT COUNT(*) as count FROM tax_transactions WHERE ${whereClause}`)
  .get() as { count: number };

const mergeTargetWhereClause = `
  source = 'hypersync'
  AND transaction_type IN ('tokentx', 'tokennfttx')
  AND id = (
    SELECT pick.id
    FROM tax_transactions pick
    WHERE pick.hash = tax_transactions.hash
      AND pick.source = 'hypersync'
      AND pick.transaction_type IN ('tokentx', 'tokennfttx')
    ORDER BY pick.id
    LIMIT 1
  )
  AND EXISTS (
    SELECT 1
    FROM tax_transactions wrapper
    WHERE wrapper.hash = tax_transactions.hash
      AND ${whereClause}
  )
  AND (fee IS NULL OR gas_used IS NULL OR gas_price IS NULL)
`;

const mergeTargetsBefore = db
  .query(`SELECT COUNT(*) as count FROM tax_transactions WHERE ${mergeTargetWhereClause}`)
  .get() as { count: number };

if (dryRun) {
  console.log(`[dry-run] DB: ${dbPath}`);
  console.log(`[dry-run] Wrapper rows matching cleanup criteria: ${wrappersBefore.count}`);
  console.log(`[dry-run] Token rows that would receive gas fields: ${mergeTargetsBefore.count}`);
  db.close(false);
  process.exit(0);
}

db.exec("BEGIN");

try {
  const mergeResult = db.run(`
    UPDATE tax_transactions
    SET
      fee = COALESCE(
        fee,
        (
          SELECT wrapper.fee
          FROM tax_transactions wrapper
          WHERE wrapper.hash = tax_transactions.hash
            AND ${whereClause}
          ORDER BY wrapper.id
          LIMIT 1
        )
      ),
      gas_used = COALESCE(
        gas_used,
        (
          SELECT wrapper.gas_used
          FROM tax_transactions wrapper
          WHERE wrapper.hash = tax_transactions.hash
            AND ${whereClause}
          ORDER BY wrapper.id
          LIMIT 1
        )
      ),
      gas_price = COALESCE(
        gas_price,
        (
          SELECT wrapper.gas_price
          FROM tax_transactions wrapper
          WHERE wrapper.hash = tax_transactions.hash
            AND ${whereClause}
          ORDER BY wrapper.id
          LIMIT 1
        )
      ),
      updated_at = datetime('now')
    WHERE ${mergeTargetWhereClause}
  `);

  const result = db.run(`DELETE FROM tax_transactions WHERE ${whereClause}`);
  db.exec("COMMIT");

  const wrappersAfter = db
    .query(`SELECT COUNT(*) as count FROM tax_transactions WHERE ${whereClause}`)
    .get() as { count: number };

  console.log(`DB: ${dbPath}`);
  console.log(`Token rows updated with merged gas fields: ${mergeResult.changes}`);
  console.log(`Rows deleted: ${result.changes}`);
  console.log(`Wrapper rows still matching criteria: ${wrappersAfter.count}`);
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close(false);
}
