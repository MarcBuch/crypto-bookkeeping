import { readFileSync } from "fs";
import { join } from "path";

import type { Address } from "viem";

export interface PositionConfig {
  openTx: string;
  closeTx?: string;
}

export interface Config {
  rpc: string;
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
}

export function loadConfig(): Config {
  const configPath = join(import.meta.dir, "..", "config.json");
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as Config;
}
