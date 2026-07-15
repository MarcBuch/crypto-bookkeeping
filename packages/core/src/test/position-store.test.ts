import { describe, expect, it } from "bun:test";

import { sqlitePositionStore } from "../db/position-store.js";
import { type StoredPosition, getPosition, upsertPosition } from "../db/store.js";
import { useTestDb } from "./helpers/db.js";

useTestDb();

const Q96 = "79228162514264337593543950336";

const basePos = {
  tokenId: 42n,
  token0: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as const,
  token1: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" as const,
  fee: 3000,
  tickLower: -100,
  tickUpper: 100,
};

const tokens = {
  token0Info: { symbol: "TKN0", decimals: 18 },
  token1Info: { symbol: "TKN1", decimals: 6 },
};

function storedPosition(
  overrides: Partial<StoredPosition> = {},
): Omit<StoredPosition, "created_at"> {
  return {
    token_id: basePos.tokenId.toString(),
    token0: basePos.token0,
    token1: basePos.token1,
    token0_symbol: tokens.token0Info.symbol,
    token1_symbol: tokens.token1Info.symbol,
    token0_decimals: tokens.token0Info.decimals,
    token1_decimals: tokens.token1Info.decimals,
    fee: basePos.fee,
    tick_lower: basePos.tickLower,
    tick_upper: basePos.tickUpper,
    entry_sqrt_price_x96: "111",
    entry_block: 100,
    entry_amount0: "1000",
    entry_amount1: "2000",
    entry_liquidity: "1000000",
    open_tx: "0xOPEN",
    ...overrides,
  };
}

function openEvent(
  overrides: Partial<{
    tokenId: bigint;
    blockNumber: bigint;
    transactionHash: string;
    amount0: bigint;
    amount1: bigint;
    liquidity: bigint;
  }> = {},
) {
  return {
    tokenId: basePos.tokenId,
    blockNumber: 100n,
    transactionHash: "0xOPEN",
    amount0: 1000n,
    amount1: 2000n,
    liquidity: 1000000n,
    ...overrides,
  };
}

function closeEvent(
  overrides: Partial<{
    tokenId: bigint;
    blockNumber: bigint;
    transactionHash: string;
    amount0: bigint;
    amount1: bigint;
    liquidity: bigint;
    cumulativeAmount0: bigint;
    cumulativeAmount1: bigint;
    collectedFees0: bigint;
    collectedFees1: bigint;
  }> = {},
) {
  return {
    tokenId: basePos.tokenId,
    blockNumber: 500n,
    transactionHash: "0xCLOSE",
    amount0: 100n,
    amount1: 200n,
    liquidity: 1000000n,
    cumulativeAmount0: 100n,
    cumulativeAmount1: 200n,
    collectedFees0: 10n,
    collectedFees1: 20n,
    ...overrides,
  };
}

describe("sqlitePositionStore", () => {
  it("repairs partial entry rows, derives entry sqrt price, and preserves stored open/close facts", () => {
    upsertPosition(
      storedPosition({
        entry_sqrt_price_x96: null,
        entry_block: null,
        open_tx: "0xORIGINAL",
        close_tx: "0xCLOSE",
        exit_amount0: "100",
        exit_amount1: "200",
        fees_collected0: "10",
        fees_collected1: "20",
        close_block: 500,
        exit_sqrt_price_x96: "222",
      }),
    );

    sqlitePositionStore.persistEntry(
      { ...basePos, tickLower: 0, tickUpper: 100 },
      openEvent({ amount1: 0n, transactionHash: "0xNEW" }),
      tokens,
    );

    const stored = getPosition(basePos.tokenId.toString());
    expect(stored?.entry_sqrt_price_x96).toBe(Q96);
    expect(stored?.entry_block).toBe(100);
    expect(stored?.open_tx).toBe("0xORIGINAL");
    expect(stored?.close_tx).toBe("0xCLOSE");
    expect(stored?.exit_sqrt_price_x96).toBe("222");
  });

  it("persists close facts without erasing entry facts", () => {
    upsertPosition(storedPosition());

    sqlitePositionStore.persistClose({
      pos: basePos,
      tokens,
      entry: {
        blockNumber: 100n,
        amount0: 1000n,
        amount1: 2000n,
        liquidity: 1000000n,
        sqrtPriceX96: 111n,
        openTx: "0xOPEN",
      },
      closeEvent: closeEvent({
        amount0: 100n,
        amount1: 200n,
        cumulativeAmount0: 130n,
        cumulativeAmount1: 260n,
      }),
      exitSqrtPriceX96: 222n,
    });

    const stored = getPosition(basePos.tokenId.toString());
    expect(stored?.entry_amount0).toBe("1000");
    expect(stored?.open_tx).toBe("0xOPEN");
    expect(stored?.close_tx).toBe("0xCLOSE");
    expect(stored?.exit_amount0).toBe("130");
    expect(stored?.exit_amount1).toBe("260");
    expect(stored?.exit_sqrt_price_x96).toBe("222");
  });

  it("persists cumulative close amounts when the same close is replayed", () => {
    upsertPosition(storedPosition());

    sqlitePositionStore.persistClose({
      pos: basePos,
      tokens,
      entry: {
        blockNumber: 100n,
        amount0: 1000n,
        amount1: 2000n,
        liquidity: 1000000n,
        sqrtPriceX96: 111n,
        openTx: "0xOPEN",
      },
      closeEvent: closeEvent({
        amount0: 100n,
        amount1: 200n,
        cumulativeAmount0: 130n,
        cumulativeAmount1: 260n,
      }),
      exitSqrtPriceX96: 222n,
    });

    sqlitePositionStore.persistClose({
      pos: basePos,
      tokens,
      entry: {
        blockNumber: 100n,
        amount0: 1000n,
        amount1: 2000n,
        liquidity: 1000000n,
        sqrtPriceX96: 111n,
        openTx: "0xOPEN",
      },
      closeEvent: closeEvent({
        amount0: 100n,
        amount1: 200n,
        cumulativeAmount0: 130n,
        cumulativeAmount1: 260n,
      }),
      exitSqrtPriceX96: 222n,
    });

    const stored = getPosition(basePos.tokenId.toString());
    expect(stored?.exit_amount0).toBe("130");
    expect(stored?.exit_amount1).toBe("260");
  });

  it("does not accept cached close rows missing exit amount1 or exit price as complete", () => {
    upsertPosition(
      storedPosition({
        close_tx: "0xCLOSE",
        exit_amount0: "130",
        exit_amount1: null,
        exit_sqrt_price_x96: null,
      }),
    );

    const stored = getPosition(basePos.tokenId.toString());
    expect(stored?.exit_amount0).toBe("130");
    expect(stored?.exit_amount1).toBeNull();
    expect(stored?.exit_sqrt_price_x96).toBeNull();
  });

  it("close writes preserve stored entry facts when later inputs conflict or omit them", () => {
    upsertPosition(storedPosition());

    sqlitePositionStore.persistClose({
      pos: basePos,
      tokens,
      entry: {
        blockNumber: 999n,
        amount0: 9999n,
        amount1: 8888n,
        liquidity: 7777n,
        sqrtPriceX96: undefined,
        openTx: null,
      },
      closeEvent: closeEvent({ transactionHash: "0xLATE" }),
      exitSqrtPriceX96: 444n,
    });

    const stored = getPosition(basePos.tokenId.toString());
    expect(stored?.entry_sqrt_price_x96).toBe("111");
    expect(stored?.entry_block).toBe(100);
    expect(stored?.entry_amount0).toBe("1000");
    expect(stored?.entry_amount1).toBe("2000");
    expect(stored?.entry_liquidity).toBe("1000000");
    expect(stored?.open_tx).toBe("0xOPEN");
    expect(stored?.close_tx).toBe("0xLATE");
    expect(stored?.exit_sqrt_price_x96).toBe("444");
  });

  it("close writes refresh stale cached close facts when a new close event is supplied", () => {
    upsertPosition(
      storedPosition({
        close_tx: "0xSTALE_CLOSE",
        exit_amount0: "999",
        exit_amount1: "888",
        fees_collected0: "7",
        fees_collected1: "8",
        close_block: 321,
        exit_sqrt_price_x96: "123456",
        close_usd_price0: 1.23,
        close_usd_price1: 4.56,
      }),
    );

    sqlitePositionStore.persistClose({
      pos: basePos,
      tokens,
      entry: {
        blockNumber: 999n,
        amount0: 9999n,
        amount1: 8888n,
        liquidity: 7777n,
        sqrtPriceX96: undefined,
        openTx: null,
      },
      closeEvent: closeEvent({
        blockNumber: 777n,
        transactionHash: "0xFRESH_CLOSE",
        amount0: 100n,
        amount1: 200n,
        collectedFees0: 10n,
        collectedFees1: 20n,
      }),
      closeBlock: 778,
      exitSqrtPriceX96: 222n,
    });

    const stored = getPosition(basePos.tokenId.toString());
    expect(stored?.entry_sqrt_price_x96).toBe("111");
    expect(stored?.entry_block).toBe(100);
    expect(stored?.entry_amount0).toBe("1000");
    expect(stored?.entry_amount1).toBe("2000");
    expect(stored?.entry_liquidity).toBe("1000000");
    expect(stored?.open_tx).toBe("0xOPEN");
    expect(stored?.close_tx).toBe("0xFRESH_CLOSE");
    expect(stored?.exit_amount0).toBe("100");
    expect(stored?.exit_amount1).toBe("200");
    expect(stored?.fees_collected0).toBe("10");
    expect(stored?.fees_collected1).toBe("20");
    expect(stored?.close_block).toBe(778);
    expect(stored?.exit_sqrt_price_x96).toBe("222");
    expect(stored?.close_usd_price0).toBe(1.23);
    expect(stored?.close_usd_price1).toBe(4.56);
  });

  it("preserves stored close USD prices when later writes pass nulls or conflicting values", () => {
    upsertPosition(
      storedPosition({
        close_tx: "0xCLOSE",
        close_block: 500,
        close_usd_price0: 1.23,
        close_usd_price1: 4.56,
      }),
    );

    sqlitePositionStore.persistCloseUsdPrices({
      pos: basePos,
      tokens,
      entry: {
        blockNumber: 999n,
        amount0: 9999n,
        amount1: 8888n,
        liquidity: 7777n,
      },
      closeBlock: 777,
      closeUsdPrice0: 9.99,
      closeUsdPrice1: null,
    });

    const stored = getPosition(basePos.tokenId.toString());
    expect(stored?.entry_sqrt_price_x96).toBe("111");
    expect(stored?.open_tx).toBe("0xOPEN");
    expect(stored?.close_usd_price0).toBe(1.23);
    expect(stored?.close_usd_price1).toBe(4.56);
  });

  it("repairs derived exit price on cached close without erasing close facts", () => {
    upsertPosition(
      storedPosition({
        close_tx: "0xCLOSE",
        exit_amount0: "100",
        exit_amount1: "200",
        fees_collected0: "10",
        fees_collected1: "20",
        close_block: 500,
      }),
    );

    const seeded = getPosition(basePos.tokenId.toString());
    expect(seeded).not.toBeNull();

    sqlitePositionStore.persistDerivedExitSqrtPrice({
      pos: basePos,
      tokens,
      storedPos: seeded!,
      exitSqrtPriceX96: 333n,
    });

    const stored = getPosition(basePos.tokenId.toString());
    expect(stored?.close_tx).toBe("0xCLOSE");
    expect(stored?.close_block).toBe(500);
    expect(stored?.exit_sqrt_price_x96).toBe("333");
    expect(stored?.entry_amount0).toBe("1000");
  });

  it("is idempotent across repeated lifecycle writes", () => {
    const firstOpen = openEvent();
    sqlitePositionStore.persistEntry(basePos, firstOpen, tokens);
    sqlitePositionStore.persistClose({
      pos: basePos,
      tokens,
      entry: {
        blockNumber: firstOpen.blockNumber,
        amount0: firstOpen.amount0,
        amount1: firstOpen.amount1,
        liquidity: firstOpen.liquidity,
        sqrtPriceX96: 111n,
        openTx: firstOpen.transactionHash,
      },
      closeEvent: closeEvent(),
      exitSqrtPriceX96: 222n,
    });
    sqlitePositionStore.persistCloseUsdPrices({
      pos: basePos,
      tokens,
      entry: {
        blockNumber: firstOpen.blockNumber,
        amount0: firstOpen.amount0,
        amount1: firstOpen.amount1,
        liquidity: firstOpen.liquidity,
      },
      closeBlock: 500,
      closeUsdPrice0: 1.23,
      closeUsdPrice1: 4.56,
    });

    const once = getPosition(basePos.tokenId.toString());

    sqlitePositionStore.persistEntry(basePos, firstOpen, tokens);
    sqlitePositionStore.persistClose({
      pos: basePos,
      tokens,
      entry: {
        blockNumber: firstOpen.blockNumber,
        amount0: firstOpen.amount0,
        amount1: firstOpen.amount1,
        liquidity: firstOpen.liquidity,
        sqrtPriceX96: 111n,
        openTx: firstOpen.transactionHash,
      },
      closeEvent: closeEvent(),
      exitSqrtPriceX96: 222n,
    });
    sqlitePositionStore.persistCloseUsdPrices({
      pos: basePos,
      tokens,
      entry: {
        blockNumber: firstOpen.blockNumber,
        amount0: firstOpen.amount0,
        amount1: firstOpen.amount1,
        liquidity: firstOpen.liquidity,
      },
      closeBlock: 500,
      closeUsdPrice0: 1.23,
      closeUsdPrice1: 4.56,
    });

    expect(getPosition(basePos.tokenId.toString())).toEqual(once);
  });
});
