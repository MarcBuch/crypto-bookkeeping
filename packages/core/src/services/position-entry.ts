import type { Address } from "viem";

import type { PositionOpenEvent } from "../chain/events.js";
import { sqlitePositionStore } from "../db/position-store.js";

/**
 * Persist a position entry to the database.
 *
 * Encapsulates the repeated pattern of:
 * 1. Deriving entry price from deposit amounts
 * 2. Upserting the position with all required fields including open_tx
 */
export function persistPositionEntry(
  pos: {
    tokenId: bigint;
    token0: Address;
    token1: Address;
    fee: number;
    tickLower: number;
    tickUpper: number;
  },
  openEvent: PositionOpenEvent,
  tokens: {
    token0Info: { symbol: string; decimals: number };
    token1Info: { symbol: string; decimals: number };
  },
): void {
  sqlitePositionStore.persistEntry(pos, openEvent, tokens);
}
