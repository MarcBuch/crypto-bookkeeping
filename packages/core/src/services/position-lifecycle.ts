import { createClient, type Client } from "../chain/client.js";
import {
  findCloseEvent,
  findOpenEvent,
  sumCollectLogsPublic,
  sumDecreaseLiquidityLogs,
  type PositionCloseEvent,
} from "../chain/events.js";
import {
  createHyperSyncClient,
  DEFAULT_HYPERSYNC_URL,
  type HypersyncClient,
} from "../chain/hypersync.js";
import {
  computeUnclaimedFeesRaw,
  getPoolAddress,
  getPoolState,
  getSlot0,
  getTokenInfo,
  type PoolState,
  type Slot0,
  type TokenInfo,
} from "../chain/pools.js";
import type { PositionData } from "../chain/positions.js";
import { withRetry } from "../chain/rpc.js";
import type { Config, PositionConfig } from "../config.js";
import { sqlitePositionStore } from "../db/position-store.js";
import { getPosition, type StoredPosition } from "../db/store.js";
import {
  deriveEntryPriceFromAmounts,
  getTokenAmounts,
  sqrtPriceX96ToPrice,
} from "../math/divergence-loss.js";
import { persistPositionEntry } from "./position-entry.js";

export interface PositionLifecycleContext {
  config: Config;
  client: Client;
  hyperSyncClient?: HypersyncClient;
  logsWindowBlocks?: bigint;
  latestBlock?: bigint;
}

export interface CurrentPositionProjection {
  token0Info: TokenInfo;
  token1Info: TokenInfo;
  poolAddress: `0x${string}`;
  poolSlot0: Slot0;
  currentAmount0: bigint;
  currentAmount1: bigint;
  currentPrice: number;
  priceLower: number;
  priceUpper: number;
  status: "active" | "closed";
  inRange: boolean;
}

export interface PositionLifecycleFacts {
  pos: PositionData;
  posConfig?: PositionConfig;
  storedPos: StoredPosition | null;
  token0Info: TokenInfo;
  token1Info: TokenInfo;
  poolAddress: `0x${string}`;
  poolState: PoolState;
  status: "active" | "closed";
  entryResolution: "resolved" | "fallback_current_amounts";
  entryAmount0: bigint;
  entryAmount1: bigint;
  entryLiquidity: bigint;
  entryBlock?: bigint;
  entrySqrtPriceX96?: bigint;
  currentAmount0: bigint;
  currentAmount1: bigint;
  withdrawnAmount0: bigint;
  withdrawnAmount1: bigint;
  exitAmount0: bigint;
  exitAmount1: bigint;
  previouslyCollectedFees0: bigint;
  previouslyCollectedFees1: bigint;
  pendingFees0: bigint;
  pendingFees1: bigint;
  totalFees0: bigint;
  totalFees1: bigint;
  exitSqrtPriceX96: bigint;
  closeBlock: number | null;
}

export type PositionLifecycleResult =
  | { status: "resolved"; facts: PositionLifecycleFacts }
  | { status: "skip"; reason: "entry_not_found" }
  | { status: "rpc_error"; stage: "entry" | "close"; error: unknown };

export async function createPositionLifecycleContext(
  config: Config,
  options?: { includeLatestBlock?: boolean },
): Promise<PositionLifecycleContext> {
  const client = createClient(config);
  const hyperSyncClient = config.hyperSync?.apiToken
    ? createHyperSyncClient({
        url: config.hyperSync.url ?? DEFAULT_HYPERSYNC_URL,
        apiToken: config.hyperSync.apiToken,
      })
    : undefined;

  return {
    config,
    client,
    hyperSyncClient,
    logsWindowBlocks: config.logsFromBlock != null ? BigInt(config.logsFromBlock) : undefined,
    latestBlock: options?.includeLatestBlock
      ? await withRetry(() => client.getBlockNumber())
      : undefined,
  };
}

export async function projectCurrentPosition(
  context: PositionLifecycleContext,
  pos: PositionData,
): Promise<CurrentPositionProjection> {
  const [token0Info, token1Info] = await Promise.all([
    getTokenInfo(context.client, pos.token0),
    getTokenInfo(context.client, pos.token1),
  ]);

  const poolAddress = await getPoolAddress(
    context.client,
    context.config.contracts.factory,
    pos.token0,
    pos.token1,
    pos.fee,
  );

  const poolSlot0 = await getSlot0(context.client, poolAddress);
  const currentAmounts = getTokenAmounts(
    pos.liquidity,
    poolSlot0.sqrtPriceX96,
    pos.tickLower,
    pos.tickUpper,
  );

  return {
    token0Info,
    token1Info,
    poolAddress,
    poolSlot0,
    currentAmount0: currentAmounts.amount0,
    currentAmount1: currentAmounts.amount1,
    currentPrice: sqrtPriceX96ToPrice(
      poolSlot0.sqrtPriceX96,
      token0Info.decimals,
      token1Info.decimals,
    ),
    priceLower: 1.0001 ** pos.tickLower * 10 ** (token0Info.decimals - token1Info.decimals),
    priceUpper: 1.0001 ** pos.tickUpper * 10 ** (token0Info.decimals - token1Info.decimals),
    status: pos.liquidity > 0n ? "active" : "closed",
    inRange: poolSlot0.tick >= pos.tickLower && poolSlot0.tick < pos.tickUpper,
  };
}

export async function resolvePositionLifecycle(
  context: PositionLifecycleContext,
  pos: PositionData,
  options?: {
    entryNotFound?: "skip" | "use_current_amounts";
    requireEntrySqrtPriceX96?: boolean;
  },
): Promise<PositionLifecycleResult> {
  const [token0Info, token1Info] = await Promise.all([
    getTokenInfo(context.client, pos.token0),
    getTokenInfo(context.client, pos.token1),
  ]);

  const poolAddress = await getPoolAddress(
    context.client,
    context.config.contracts.factory,
    pos.token0,
    pos.token1,
    pos.fee,
  );
  const poolState = await getPoolState(context.client, poolAddress);
  const storedPos = getPosition(pos.tokenId.toString());
  const posConfig = context.config.positions?.[pos.tokenId.toString()];
  const isActive = pos.liquidity > 0n;
  const currentAmounts = getTokenAmounts(
    pos.liquidity,
    poolState.sqrtPriceX96,
    pos.tickLower,
    pos.tickUpper,
  );

  let entryAmount0 = 0n;
  let entryAmount1 = 0n;
  let entryLiquidity = pos.liquidity;
  let entryBlock = storedPos?.entry_block != null ? BigInt(storedPos.entry_block) : undefined;
  let entrySqrtPriceX96 =
    storedPos?.entry_sqrt_price_x96 != null ? BigInt(storedPos.entry_sqrt_price_x96) : undefined;

  const hasStoredEntry = storedPos?.entry_amount0 != null && storedPos.entry_amount0 !== "0";
  const hasStoredLiquidity =
    storedPos?.entry_liquidity != null && storedPos.entry_liquidity !== "0";

  const needsHistoricalEntrySqrtPrice = options?.requireEntrySqrtPriceX96 === true;

  if (posConfig?.openTx) {
    const openResult = await findOpenEvent(
      context.client,
      context.config.contracts.positionManager,
      pos.tokenId,
      context.config.wallet,
      posConfig.openTx,
      undefined,
      context.logsWindowBlocks,
      context.latestBlock,
      context.hyperSyncClient,
    );

    if (openResult.status === "rpc_error") {
      return { status: "rpc_error", stage: "entry", error: openResult.error };
    }

    if (openResult.status === "found") {
      const openEvent = openResult.event;
      entryAmount0 = openEvent.amount0;
      entryAmount1 = openEvent.amount1;
      entryLiquidity = openEvent.liquidity;
      entryBlock = openEvent.blockNumber;
      entrySqrtPriceX96 = deriveEntryPriceFromAmounts(
        openEvent.amount0,
        openEvent.amount1,
        openEvent.liquidity,
        pos.tickLower,
        pos.tickUpper,
      );

      if (
        !hasStoredEntry ||
        !hasStoredLiquidity ||
        !storedPos?.open_tx ||
        storedPos.entry_block == null ||
        storedPos.entry_sqrt_price_x96 == null
      ) {
        persistPositionEntry(pos, openEvent, { token0Info, token1Info });
      }
    } else if (options?.entryNotFound === "use_current_amounts") {
      entryAmount0 = currentAmounts.amount0;
      entryAmount1 = currentAmounts.amount1;
      entryLiquidity = pos.liquidity;
      entrySqrtPriceX96 = poolState.sqrtPriceX96;
    } else {
      return { status: "skip", reason: "entry_not_found" };
    }
  } else if (storedPos?.open_tx && (!needsHistoricalEntrySqrtPrice || entrySqrtPriceX96 != null)) {
    entryAmount0 = BigInt(storedPos.entry_amount0 || "0");
    entryAmount1 = BigInt(storedPos.entry_amount1 || "0");
    if (hasStoredLiquidity && storedPos.entry_liquidity) {
      entryLiquidity = BigInt(storedPos.entry_liquidity);
    }
  } else if (
    storedPos &&
    hasStoredEntry &&
    (hasStoredLiquidity || isActive) &&
    (!needsHistoricalEntrySqrtPrice || entrySqrtPriceX96 != null)
  ) {
    entryAmount0 = BigInt(storedPos.entry_amount0 || "0");
    entryAmount1 = BigInt(storedPos.entry_amount1 || "0");
    if (hasStoredLiquidity && storedPos.entry_liquidity) {
      entryLiquidity = BigInt(storedPos.entry_liquidity);
    }
  } else {
    const openResult = await findOpenEvent(
      context.client,
      context.config.contracts.positionManager,
      pos.tokenId,
      context.config.wallet,
      undefined,
      undefined,
      context.logsWindowBlocks,
      context.latestBlock,
      context.hyperSyncClient,
    );

    if (openResult.status === "rpc_error") {
      return { status: "rpc_error", stage: "entry", error: openResult.error };
    }

    if (openResult.status === "found") {
      const openEvent = openResult.event;
      entryAmount0 = openEvent.amount0;
      entryAmount1 = openEvent.amount1;
      entryLiquidity = openEvent.liquidity;
      entryBlock = openEvent.blockNumber;
      entrySqrtPriceX96 = deriveEntryPriceFromAmounts(
        openEvent.amount0,
        openEvent.amount1,
        openEvent.liquidity,
        pos.tickLower,
        pos.tickUpper,
      );
      persistPositionEntry(pos, openEvent, { token0Info, token1Info });
    } else if (options?.entryNotFound === "use_current_amounts") {
      entryAmount0 = currentAmounts.amount0;
      entryAmount1 = currentAmounts.amount1;
      entryLiquidity = pos.liquidity;
      entrySqrtPriceX96 = poolState.sqrtPriceX96;
    } else {
      return { status: "skip", reason: "entry_not_found" };
    }
  }

  let currentAmount0 = currentAmounts.amount0;
  let currentAmount1 = currentAmounts.amount1;
  let withdrawnAmount0 = 0n;
  let withdrawnAmount1 = 0n;
  let exitAmount0 = currentAmounts.amount0;
  let exitAmount1 = currentAmounts.amount1;
  let previouslyCollectedFees0 = 0n;
  let previouslyCollectedFees1 = 0n;
  let pendingFees0 = 0n;
  let pendingFees1 = 0n;
  let totalFees0 = 0n;
  let totalFees1 = 0n;
  let exitSqrtPriceX96 = poolState.sqrtPriceX96;
  let closeBlock = storedPos?.close_block ?? null;

  if (isActive) {
    if (entryBlock !== undefined && supportsLogScanning(context.client)) {
      const latestBlock = await getLatestBlock(context);
      const [withdrawn, alreadyCollected] = await Promise.all([
        sumDecreaseLiquidityLogs(
          context.client,
          context.config.contracts.positionManager,
          pos.tokenId,
          entryBlock,
          latestBlock,
          context.hyperSyncClient,
        ),
        sumCollectLogsPublic(
          context.client,
          context.config.contracts.positionManager,
          pos.tokenId,
          entryBlock,
          latestBlock,
          context.hyperSyncClient,
        ),
      ]);
      withdrawnAmount0 = withdrawn.amount0;
      withdrawnAmount1 = withdrawn.amount1;
      exitAmount0 += withdrawn.amount0;
      exitAmount1 += withdrawn.amount1;
      previouslyCollectedFees0 =
        alreadyCollected.amount0 > withdrawn.amount0
          ? alreadyCollected.amount0 - withdrawn.amount0
          : 0n;
      previouslyCollectedFees1 =
        alreadyCollected.amount1 > withdrawn.amount1
          ? alreadyCollected.amount1 - withdrawn.amount1
          : 0n;
    }

    const feeResult = await computeUnclaimedFeesRaw(context.client, poolAddress, pos, poolState);
    pendingFees0 = feeResult.fees0;
    pendingFees1 = feeResult.fees1;
    totalFees0 = previouslyCollectedFees0 + pendingFees0;
    totalFees1 = previouslyCollectedFees1 + pendingFees1;
  } else {
    const hasCachedExit =
      storedPos?.close_tx &&
      storedPos.exit_amount0 != null &&
      storedPos.exit_amount1 != null &&
      storedPos.exit_sqrt_price_x96 != null &&
      !posConfig?.closeTx;

    if (hasCachedExit && storedPos) {
      currentAmount0 = 0n;
      currentAmount1 = 0n;
      withdrawnAmount0 = BigInt(storedPos.exit_amount0!);
      withdrawnAmount1 = BigInt(storedPos.exit_amount1!);
      exitAmount0 = withdrawnAmount0;
      exitAmount1 = withdrawnAmount1;
      previouslyCollectedFees0 = BigInt(storedPos.fees_collected0 ?? "0");
      previouslyCollectedFees1 = BigInt(storedPos.fees_collected1 ?? "0");
      totalFees0 = previouslyCollectedFees0;
      totalFees1 = previouslyCollectedFees1;
      exitSqrtPriceX96 = BigInt(storedPos.exit_sqrt_price_x96!);
    } else {
      const latestBlock = await getLatestBlock(context);
      const closeResult = await findCloseEvent(
        context.client,
        context.config.contracts.positionManager,
        pos.tokenId,
        context.config.wallet,
        posConfig?.closeTx,
        entryBlock,
        context.logsWindowBlocks,
        latestBlock,
        context.hyperSyncClient,
      );

      if (closeResult.status === "rpc_error") {
        return { status: "rpc_error", stage: "close", error: closeResult.error };
      }

      if (closeResult.status === "found") {
        const closeEvent = closeResult.event;
        currentAmount0 = 0n;
        currentAmount1 = 0n;
        withdrawnAmount0 = closeEvent.cumulativeAmount0;
        withdrawnAmount1 = closeEvent.cumulativeAmount1;
        exitAmount0 = closeEvent.cumulativeAmount0;
        exitAmount1 = closeEvent.cumulativeAmount1;
        previouslyCollectedFees0 = closeEvent.collectedFees0;
        previouslyCollectedFees1 = closeEvent.collectedFees1;
        totalFees0 = closeEvent.collectedFees0;
        totalFees1 = closeEvent.collectedFees1;
        closeBlock = Number(closeEvent.blockNumber);
        exitSqrtPriceX96 =
          storedPos?.exit_sqrt_price_x96 && !posConfig?.closeTx
            ? BigInt(storedPos.exit_sqrt_price_x96)
            : deriveEntryPriceFromAmounts(
                closeEvent.amount0,
                closeEvent.amount1,
                closeEvent.liquidity,
                pos.tickLower,
                pos.tickUpper,
              );

        persistPositionClose({
          pos,
          storedPos,
          token0Info,
          token1Info,
          entryBlock,
          entryAmount0,
          entryAmount1,
          entryLiquidity,
          closeBlock,
          exitSqrtPriceX96,
          closeEvent,
        });
      } else {
        currentAmount0 = 0n;
        currentAmount1 = 0n;
        exitAmount0 = 0n;
        exitAmount1 = 0n;
      }
    }
  }

  return {
    status: "resolved",
    facts: {
      pos,
      posConfig,
      storedPos,
      token0Info,
      token1Info,
      poolAddress,
      poolState,
      status: isActive ? "active" : "closed",
      entryResolution:
        entryAmount0 === currentAmounts.amount0 &&
        entryAmount1 === currentAmounts.amount1 &&
        options?.entryNotFound === "use_current_amounts" &&
        !hasStoredEntry
          ? "fallback_current_amounts"
          : "resolved",
      entryAmount0,
      entryAmount1,
      entryLiquidity,
      entryBlock,
      entrySqrtPriceX96,
      currentAmount0,
      currentAmount1,
      withdrawnAmount0,
      withdrawnAmount1,
      exitAmount0,
      exitAmount1,
      previouslyCollectedFees0,
      previouslyCollectedFees1,
      pendingFees0,
      pendingFees1,
      totalFees0,
      totalFees1,
      exitSqrtPriceX96,
      closeBlock,
    },
  };
}

async function getLatestBlock(context: PositionLifecycleContext): Promise<bigint> {
  if (context.latestBlock == null) {
    context.latestBlock = await withRetry(() => context.client.getBlockNumber());
  }
  return context.latestBlock;
}

function supportsLogScanning(client: Client): client is Client & { getLogs: Client["getLogs"] } {
  return typeof client.getLogs === "function";
}

function persistPositionClose(params: {
  pos: PositionData;
  storedPos: StoredPosition | null;
  token0Info: TokenInfo;
  token1Info: TokenInfo;
  entryBlock?: bigint;
  entryAmount0: bigint;
  entryAmount1: bigint;
  entryLiquidity: bigint;
  closeBlock: number;
  exitSqrtPriceX96: bigint;
  closeEvent: PositionCloseEvent;
}): void {
  sqlitePositionStore.persistClose({
    pos: params.pos,
    tokens: {
      token0Info: params.token0Info,
      token1Info: params.token1Info,
    },
    entry: {
      blockNumber: params.entryBlock,
      amount0: params.entryAmount0,
      amount1: params.entryAmount1,
      liquidity: params.entryLiquidity,
      sqrtPriceX96:
        params.storedPos?.entry_sqrt_price_x96 != null
          ? BigInt(params.storedPos.entry_sqrt_price_x96)
          : undefined,
      openTx: params.storedPos?.open_tx ?? null,
    },
    closeEvent: params.closeEvent,
    closeBlock: params.closeBlock,
    exitSqrtPriceX96: params.exitSqrtPriceX96,
  });
}
