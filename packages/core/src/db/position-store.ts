import type { Address } from "viem";

import type { PositionCloseEvent, PositionOpenEvent } from "../chain/events.js";
import { deriveEntryPriceFromAmounts } from "../math/divergence-loss.js";
import { getPosition, type StoredPosition, upsertPosition } from "./store.js";

type PositionShape = {
  tokenId: bigint;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
};

type TokenMetadata = {
  token0Info: { symbol: string | null; decimals: number | null };
  token1Info: { symbol: string | null; decimals: number | null };
};

export interface PositionEntryFacts {
  blockNumber?: bigint;
  amount0: bigint;
  amount1: bigint;
  liquidity: bigint;
  sqrtPriceX96?: bigint;
  openTx?: string | null;
}

export interface PersistPositionCloseParams {
  pos: PositionShape;
  tokens: TokenMetadata;
  entry: PositionEntryFacts;
  closeEvent: PositionCloseEvent;
  closeBlock?: number;
  exitSqrtPriceX96: bigint;
}

export interface PersistPositionCloseUsdPricesParams {
  pos: PositionShape;
  tokens: TokenMetadata;
  entry: PositionEntryFacts;
  closeBlock: number;
  closeUsdPrice0: number | null;
  closeUsdPrice1: number | null;
}

export interface PersistDerivedExitSqrtPriceParams {
  pos: PositionShape;
  tokens: TokenMetadata;
  storedPos: StoredPosition;
  exitSqrtPriceX96: bigint;
}

export interface PositionStore {
  persistEntry(pos: PositionShape, openEvent: PositionOpenEvent, tokens: TokenMetadata): void;
  persistClose(params: PersistPositionCloseParams): void;
  persistCloseUsdPrices(params: PersistPositionCloseUsdPricesParams): void;
  persistDerivedExitSqrtPrice(params: PersistDerivedExitSqrtPriceParams): void;
}

function baseRow(pos: PositionShape, tokens: TokenMetadata) {
  return {
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
  };
}

function entryColumns(entry: PositionEntryFacts) {
  return {
    entry_sqrt_price_x96: entry.sqrtPriceX96?.toString() ?? null,
    entry_block: entry.blockNumber != null ? Number(entry.blockNumber) : null,
    entry_amount0: entry.amount0.toString(),
    entry_amount1: entry.amount1.toString(),
    entry_liquidity: entry.liquidity.toString(),
    open_tx: entry.openTx ?? null,
  };
}

function preserveStoredValue<T>(stored: T | null | undefined, incoming: T | null | undefined): T | null {
  return stored ?? incoming ?? null;
}

function getStoredPosition(pos: PositionShape): StoredPosition | null {
  return getPosition(pos.tokenId.toString());
}

function mergedEntryColumns(existing: StoredPosition | null, entry: PositionEntryFacts) {
  const incoming = entryColumns(entry);
  return {
    entry_sqrt_price_x96: preserveStoredValue(
      existing?.entry_sqrt_price_x96,
      incoming.entry_sqrt_price_x96,
    ),
    entry_block: preserveStoredValue(existing?.entry_block, incoming.entry_block),
    entry_amount0: preserveStoredValue(existing?.entry_amount0, incoming.entry_amount0),
    entry_amount1: preserveStoredValue(existing?.entry_amount1, incoming.entry_amount1),
    entry_liquidity: preserveStoredValue(existing?.entry_liquidity, incoming.entry_liquidity),
    open_tx: preserveStoredValue(existing?.open_tx, incoming.open_tx),
  };
}

export const sqlitePositionStore: PositionStore = {
  persistEntry(pos, openEvent, tokens) {
    const existing = getStoredPosition(pos);
    upsertPosition({
      ...baseRow(pos, tokens),
      ...mergedEntryColumns(existing, {
        blockNumber: openEvent.blockNumber,
        amount0: openEvent.amount0,
        amount1: openEvent.amount1,
        liquidity: openEvent.liquidity,
        sqrtPriceX96: deriveEntryPriceFromAmounts(
          openEvent.amount0,
          openEvent.amount1,
          openEvent.liquidity,
          pos.tickLower,
          pos.tickUpper,
        ),
        openTx: openEvent.transactionHash,
      }),
    });
  },

  persistClose({ pos, tokens, entry, closeEvent, closeBlock, exitSqrtPriceX96 }) {
    const existing = getStoredPosition(pos);
    upsertPosition({
      ...baseRow(pos, tokens),
      ...mergedEntryColumns(existing, entry),
      close_tx: closeEvent.transactionHash,
      exit_amount0: closeEvent.amount0.toString(),
      exit_amount1: closeEvent.amount1.toString(),
      fees_collected0: closeEvent.collectedFees0.toString(),
      fees_collected1: closeEvent.collectedFees1.toString(),
      close_block: closeBlock ?? Number(closeEvent.blockNumber),
      exit_sqrt_price_x96: exitSqrtPriceX96.toString(),
    });
  },

  persistCloseUsdPrices({ pos, tokens, entry, closeBlock, closeUsdPrice0, closeUsdPrice1 }) {
    const existing = getStoredPosition(pos);
    upsertPosition({
      ...baseRow(pos, tokens),
      ...mergedEntryColumns(existing, entry),
      close_block: preserveStoredValue(existing?.close_block, closeBlock),
      close_usd_price0: preserveStoredValue(existing?.close_usd_price0, closeUsdPrice0),
      close_usd_price1: preserveStoredValue(existing?.close_usd_price1, closeUsdPrice1),
    });
  },

  persistDerivedExitSqrtPrice({ pos, tokens, storedPos, exitSqrtPriceX96 }) {
    upsertPosition({
      ...baseRow(pos, tokens),
      entry_sqrt_price_x96: storedPos.entry_sqrt_price_x96 ?? null,
      entry_block: storedPos.entry_block ?? null,
      entry_amount0: storedPos.entry_amount0 ?? null,
      entry_amount1: storedPos.entry_amount1 ?? null,
      entry_liquidity: storedPos.entry_liquidity ?? null,
      exit_sqrt_price_x96: storedPos.exit_sqrt_price_x96 ?? exitSqrtPriceX96.toString(),
    });
  },
};
