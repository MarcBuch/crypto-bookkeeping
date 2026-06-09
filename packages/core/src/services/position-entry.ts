import type { Address } from "viem";

import type { PositionOpenEvent } from "../chain/events.js";
import { deriveEntryPriceFromAmounts } from "../math/divergence-loss.js";
import { upsertPosition } from "../db/store.js";

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
  // Derive entry price from actual deposit amounts
  const entrySqrtPriceX96 = deriveEntryPriceFromAmounts(
    openEvent.amount0,
    openEvent.amount1,
    openEvent.liquidity,
    pos.tickLower,
    pos.tickUpper,
  );

  // Upsert position with all 16 fields
  upsertPosition({
    token_id: pos.tokenId.toString(),
    token0: pos.token0,
    token1: pos.token1,
    token0_symbol: tokens.token0Info.symbol,
    token1_symbol: tokens.token1Info.symbol,
    token0_decimals: tokens.token0Info.decimals,
    token1_decimals: tokens.token1Info.decimals,
    fee: pos.fee,
    tick_lower: pos.tickLower,
    tick_upper: pos.tickUpper,
    entry_sqrt_price_x96: entrySqrtPriceX96.toString(),
    entry_block: Number(openEvent.blockNumber),
    entry_amount0: openEvent.amount0.toString(),
    entry_amount1: openEvent.amount1.toString(),
    entry_liquidity: openEvent.liquidity.toString(),
    open_tx: openEvent.transactionHash,
  });
}
