import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

import type { Address } from "viem";

export interface PositionConfig {
  openTx: string;
  closeTx?: string;
  hedge?: {
    coin: string;
  };
}

export interface PricingConfig {
  /** CoinGecko ids keyed by token symbol or token address */
  coingeckoIds?: Record<string, string>;
  /** Hyperliquid coin names keyed by token symbol or address (e.g. { UBTC: "BTC", WHYPE: "HYPE" }) */
  hyperliquidSymbols?: Record<string, string>;
}

export interface HyperSyncSharedConfig {
  /** HyperSync URL. Default: "https://hyperliquid.hypersync.xyz" */
  url?: string;
  /** HyperSync API token (required since Nov 2025) */
  apiToken?: string;
}

export interface TaxConfig {
  // HyperSync fields (new — preferred)
  /** HyperSync URL for Hyperliquid. Default: "https://hyperliquid.hypersync.xyz" */
  hyperSyncUrl?: string;
  /** HyperSync API token (required since Nov 2025). */
  hyperSyncApiToken?: string;

  // Explorer fields (kept for txlistinternal and backward compat)
  explorerApiUrl?: string;
  explorerApiKey?: string;
  explorerChainId?: number;
}

export interface Config {
  /** Full-node RPC used for eth_call / readContract (e.g. public Hyperliquid RPC). */
  rpc: string;
  /**
   * Optional Envio HyperRPC endpoint used for eth_getLogs and
   * eth_getTransactionReceipt. Supports 100k-block ranges and has relaxed
   * rate limits. Falls back to `rpc` if not set.
   * Format: https://hyperliquid.rpc.hypersync.xyz/<api-token>
   */
  logsRpc?: string;
  chainId: number;
  wallet: Address;
  contracts: {
    factory: Address;
    positionManager: Address;
    quoter: Address;
    swapRouter: Address;
  };
  /** Known position transaction hashes for fast lookups (keyed by tokenId) */
  positions?: Record<string, PositionConfig>;
  /** Optional live USD pricing configuration */
  pricing?: PricingConfig;
  /** Shared HyperSync data API config used by LP services and (as fallback) by the tax service. */
  hyperSync?: HyperSyncSharedConfig;
  /** Optional tax transaction sync configuration */
  tax?: TaxConfig;
  /** Optional: number of blocks to scan back from the chain head when discovering
   *  position open/close events via getLogs. Defaults to ~30 days (2,592,000 blocks
   *  at ~1 block/sec on HyperEVM) if omitted. Must be a positive integer. */
  logsFromBlock?: number;
}

/**
 * Resolve the config file path.
 *
 * Resolution order:
 *   1. LP_TRACKER_CONFIG env var (absolute or relative to cwd)
 *   2. config.json in the current working directory
 *   3. config.json two levels up from this file (repo root, for development)
 */
export function resolveConfigPath(): string {
  if (process.env.LP_TRACKER_CONFIG) {
    return resolve(process.env.LP_TRACKER_CONFIG);
  }
  const cwdPath = join(process.cwd(), "config.json");
  if (existsSync(cwdPath)) {
    return cwdPath;
  }
  // Fallback: repo root relative to packages/core/src/config.ts → ../../../config.json
  return join(import.meta.dir, "..", "..", "..", "config.json");
}

export function loadConfig(configPath?: string): Config {
  const path = configPath ?? resolveConfigPath();

  if (!existsSync(path)) {
    throw new Error(
      `Config file not found: ${path}\n` +
        `Set LP_TRACKER_CONFIG env var or place config.json in the working directory.\n` +
        `Copy config.example.json to config.json and fill in your details.`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err: any) {
    throw new Error(`Failed to read config file at ${path}: ${err.message}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`Config file at ${path} is not valid JSON: ${err.message}`, { cause: err });
  }

  validateConfig(parsed, path);
  return parsed as Config;
}

function validateConfig(raw: unknown, path: string): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Config at ${path} must be a JSON object`);
  }
  const cfg = raw as Record<string, unknown>;

  const required = ["rpc", "chainId", "wallet", "contracts"] as const;
  for (const key of required) {
    if (cfg[key] === undefined || cfg[key] === null) {
      throw new Error(`Config at ${path} is missing required field: "${key}"`);
    }
  }

  if (typeof cfg.contracts !== "object" || cfg.contracts === null) {
    throw new Error(`Config at ${path}: "contracts" must be an object`);
  }
  const contracts = cfg.contracts as Record<string, unknown>;
  const requiredContracts = ["factory", "positionManager", "quoter", "swapRouter"] as const;
  for (const key of requiredContracts) {
    if (!contracts[key]) {
      throw new Error(`Config at ${path} is missing required contract address: "contracts.${key}"`);
    }
  }

  if (cfg.logsFromBlock !== undefined && cfg.logsFromBlock !== null) {
    const v = cfg.logsFromBlock;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new Error(
        `Config at ${path}: "logsFromBlock" must be a positive integer (got ${JSON.stringify(v)})`,
      );
    }
  }

  // Validate tax config if present
  if (cfg.tax !== undefined && cfg.tax !== null) {
    const tax = cfg.tax as Record<string, unknown>;
    if (tax.hyperSyncUrl !== undefined && tax.hyperSyncUrl !== null) {
      if (typeof tax.hyperSyncUrl !== "string" || !tax.hyperSyncUrl.trim()) {
        throw new Error(`Config at ${path}: "tax.hyperSyncUrl" must be a non-empty string`);
      }
      // Basic URL validation
      if (!URL.canParse(tax.hyperSyncUrl as string)) {
        throw new Error(
          `Config at ${path}: "tax.hyperSyncUrl" must be a valid URL (got ${JSON.stringify(tax.hyperSyncUrl)})`,
        );
      }
    }
    if (tax.hyperSyncApiToken !== undefined && tax.hyperSyncApiToken !== null) {
      if (typeof tax.hyperSyncApiToken !== "string") {
        throw new Error(`Config at ${path}: "tax.hyperSyncApiToken" must be a string`);
      }
      // Empty string treated as absent — no error, just ignored at runtime
    }
  }

  // Validate hyperSync config if present
  if (cfg.hyperSync !== undefined && cfg.hyperSync !== null) {
    const hyperSync = cfg.hyperSync as Record<string, unknown>;
    if (hyperSync.url !== undefined && hyperSync.url !== null) {
      if (typeof hyperSync.url !== "string" || !hyperSync.url.trim()) {
        throw new Error(`Config at ${path}: "hyperSync.url" must be a non-empty string`);
      }
      // Basic URL validation
      if (!URL.canParse(hyperSync.url as string)) {
        throw new Error(
          `Config at ${path}: "hyperSync.url" must be a valid URL (got ${JSON.stringify(hyperSync.url)})`,
        );
      }
    }
    if (hyperSync.apiToken !== undefined && hyperSync.apiToken !== null) {
      if (typeof hyperSync.apiToken !== "string") {
        throw new Error(`Config at ${path}: "hyperSync.apiToken" must be a string`);
      }
      // Empty string treated as absent — no error, just ignored at runtime
    }
  }
}
