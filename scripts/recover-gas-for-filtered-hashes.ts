import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface ConfigFile {
  rpc?: string;
}

interface RpcReceipt {
  gasUsed?: string;
  effectiveGasPrice?: string;
}

interface RpcTransaction {
  gasPrice?: string;
}

interface CandidateRow {
  hash: string;
  token_row_id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable value]";
  }
}

function parseConfigFile(value: unknown): ConfigFile {
  if (!isRecord(value)) {
    return {};
  }

  return {
    rpc: typeof value.rpc === "string" ? value.rpc : undefined,
  };
}

function getRpcError(value: unknown): { code: string; message: string } | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (!isRecord(value)) {
    return { code: "unknown", message: describeUnknown(value) };
  }

  return {
    code: Object.hasOwn(value, "code") ? describeUnknown(value.code) : "unknown",
    message: typeof value.message === "string" ? value.message : describeUnknown(value.message),
  };
}

function parseRpcReceipt(value: unknown): RpcReceipt | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    gasUsed: typeof value.gasUsed === "string" ? value.gasUsed : undefined,
    effectiveGasPrice:
      typeof value.effectiveGasPrice === "string" ? value.effectiveGasPrice : undefined,
  };
}

function parseRpcTransaction(value: unknown): RpcTransaction | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    gasPrice: typeof value.gasPrice === "string" ? value.gasPrice : undefined,
  };
}

function parseCandidateRows(value: unknown): CandidateRow[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected candidate query to return an array");
  }

  return value.map((row) => {
    if (!isRecord(row) || typeof row.hash !== "string" || typeof row.token_row_id !== "string") {
      throw new Error("Expected candidate row with string hash and token_row_id");
    }

    return {
      hash: row.hash,
      token_row_id: row.token_row_id,
    };
  });
}

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

function resolveRpcUrl(): string {
  if (process.env.RPC_URL) return process.env.RPC_URL;

  const configPath = join(process.cwd(), "config.json");
  if (!existsSync(configPath)) {
    throw new Error("Missing RPC URL: set RPC_URL or provide config.json with rpc");
  }

  const config = parseConfigFile(JSON.parse(readFileSync(configPath, "utf8")));
  if (!config.rpc) {
    throw new Error("Missing RPC URL: set RPC_URL or config.json.rpc");
  }

  return config.rpc;
}

function parseArgs(args: string[]): { dryRun: boolean; hashes: string[] } {
  const hashes: string[] = [];
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--hash") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --hash");
      }
      hashes.push(value.toLowerCase());
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { dryRun, hashes };
}

async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  parseResult: (value: unknown) => T | null,
): Promise<T | null> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
  }

  const payload = await response.json();

  if (isRecord(payload)) {
    const error = getRpcError(payload.error);
    if (error) {
      throw new Error(`RPC ${method} error ${error.code}: ${error.message}`);
    }

    return Object.hasOwn(payload, "result") ? parseResult(payload.result) : null;
  }

  return null;
}

function hexToBigInt(value: string | undefined | null): bigint | null {
  if (!value) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

const { dryRun, hashes } = parseArgs(process.argv.slice(2));
const dbPath = resolveDbPath();

if (!existsSync(dbPath)) {
  throw new Error(`Database not found at ${dbPath}`);
}

const rpcUrl = resolveRpcUrl();
const db = new Database(dbPath);

const hashFilterSql =
  hashes.length > 0 ? `AND tx.hash IN (${hashes.map(() => "?").join(",")})` : "";

const candidates = parseCandidateRows(
  db
    .query(
      `SELECT tx.hash, MIN(tx.id) AS token_row_id
       FROM tax_transactions tx
       WHERE tx.source = 'hypersync'
         AND tx.transaction_type IN ('tokentx', 'tokennfttx')
         AND tx.fee IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM tax_transactions wrapper
           WHERE wrapper.hash = tx.hash
             AND wrapper.source = 'hypersync'
             AND wrapper.transaction_type = 'txlist'
         )
         ${hashFilterSql}
       GROUP BY tx.hash
       ORDER BY tx.hash`,
    )
    .all(...hashes),
);

if (candidates.length === 0) {
  console.log("No matching hashes found for gas recovery.");
  db.close(false);
  process.exit(0);
}

console.log(`DB: ${dbPath}`);
console.log(`RPC: ${rpcUrl}`);
console.log(`Candidate hashes: ${candidates.length}`);

if (dryRun) {
  for (const candidate of candidates) {
    console.log(`[dry-run] ${candidate.hash} -> ${candidate.token_row_id}`);
  }
  db.close(false);
  process.exit(0);
}

let updated = 0;
let skipped = 0;

db.exec("BEGIN");

try {
  for (const candidate of candidates) {
    const receipt = await rpcCall(
      rpcUrl,
      "eth_getTransactionReceipt",
      [candidate.hash],
      parseRpcReceipt,
    );
    const transaction = await rpcCall(
      rpcUrl,
      "eth_getTransactionByHash",
      [candidate.hash],
      parseRpcTransaction,
    );

    const gasUsed = hexToBigInt(receipt?.gasUsed);
    const gasPrice = hexToBigInt(receipt?.effectiveGasPrice) ?? hexToBigInt(transaction?.gasPrice);

    if (gasUsed === null || gasPrice === null) {
      console.log(`[skip] ${candidate.hash} missing gas data from RPC`);
      skipped += 1;
      continue;
    }

    const fee = gasUsed * gasPrice;

    const result = db.run(
      `UPDATE tax_transactions
       SET fee = ?, gas_used = ?, gas_price = ?, updated_at = datetime('now')
       WHERE id = ?
         AND fee IS NULL`,
      [fee.toString(), gasUsed.toString(), gasPrice.toString(), candidate.token_row_id],
    );

    if (result.changes > 0) {
      console.log(`[ok] ${candidate.hash} fee=${fee.toString()} gas_used=${gasUsed.toString()}`);
      updated += 1;
    } else {
      console.log(`[skip] ${candidate.hash} row already updated`);
      skipped += 1;
    }
  }

  db.exec("COMMIT");
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close(false);
}
