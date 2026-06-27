import { createClient } from "../chain/client.js";
import { getAllPositions } from "../chain/positions.js";
import type { Config } from "../config.js";
import { insertSnapshot } from "../db/store.js";
import { calculateLpEconomics } from "./lp-economics.js";
import { createPositionLifecycleContext, resolvePositionLifecycle } from "./position-lifecycle.js";

export interface SnapshotResult {
  tokenId: string;
  saved: boolean;
  message: string;
}

export async function takeSnapshot(config: Config): Promise<SnapshotResult[]> {
  const client = createClient(config);
  const lifecycleContext = await createPositionLifecycleContext(config, {
    includeLatestBlock: true,
  });

  const positions = await getAllPositions(client, config.contracts.positionManager, config.wallet);

  if (positions.length === 0) {
    return [];
  }

  const results: SnapshotResult[] = [];

  for (const pos of positions) {
    // Skip positions with 0 liquidity (closed)
    if (pos.liquidity === 0n) {
      results.push({
        tokenId: pos.tokenId.toString(),
        saved: false,
        message: `Skipped position #${pos.tokenId} (closed)`,
      });
      continue;
    }

    const lifecycle = await resolvePositionLifecycle(lifecycleContext, pos, {
      entryNotFound: "use_current_amounts",
    });
    if (lifecycle.status === "rpc_error") {
      console.error(
        `[lp-tracker] RPC error discovering ${lifecycle.stage} event for position ${pos.tokenId.toString()}:`,
        lifecycle.error,
      );
      continue;
    }
    if (lifecycle.status !== "resolved") continue;
    const { facts } = lifecycle;
    const { token0Info, token1Info, poolState } = facts;
    const economics = calculateLpEconomics(facts);

    // Store snapshot
    insertSnapshot({
      token_id: pos.tokenId.toString(),
      timestamp: new Date().toISOString(),
      liquidity: pos.liquidity.toString(),
      current_sqrt_price_x96: poolState.sqrtPriceX96.toString(),
      current_tick: poolState.tick,
      current_amount0: economics.exitAmount0.toString(),
      current_amount1: economics.exitAmount1.toString(),
      entry_amount0: economics.entryAmount0.toString(),
      entry_amount1: economics.entryAmount1.toString(),
      value_lp: economics.exitValueInToken1,
      value_hold: economics.holdValueInToken1,
      divergence_loss: economics.divergenceLossPercent,
      fees0: economics.totalFees0,
      fees1: economics.totalFees1,
      fees_value: economics.totalFeesValueInToken1,
      net_pnl: economics.netVsHodlInToken1,
    });

    results.push({
      tokenId: pos.tokenId.toString(),
      saved: true,
      message: `Snapshot saved for #${pos.tokenId} (${token0Info.symbol}/${token1Info.symbol}) - DL: ${(economics.divergenceLossPercent * 100).toFixed(4)}%`,
    });
  }

  return results;
}
