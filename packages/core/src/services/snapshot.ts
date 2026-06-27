import { createClient } from "../chain/client.js";
import { getAllPositions } from "../chain/positions.js";
import type { Config } from "../config.js";
import { insertSnapshot } from "../db/store.js";
import { sqrtPriceX96ToPrice } from "../math/divergence-loss.js";
import {
  createPositionLifecycleContext,
  resolvePositionLifecycle,
} from "./position-lifecycle.js";

export interface SnapshotResult {
  tokenId: string;
  saved: boolean;
  message: string;
}

export async function takeSnapshot(config: Config): Promise<SnapshotResult[]> {
  const client = createClient(config);
  const lifecycleContext = await createPositionLifecycleContext(config, { includeLatestBlock: true });

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

    const exitPrice = sqrtPriceX96ToPrice(
      poolState.sqrtPriceX96,
      token0Info.decimals,
      token1Info.decimals,
    );
    const entryAmt0H = Number(facts.entryAmount0) / 10 ** token0Info.decimals;
    const entryAmt1H = Number(facts.entryAmount1) / 10 ** token1Info.decimals;
    const curAmt0H = Number(facts.currentAmount0) / 10 ** token0Info.decimals;
    const curAmt1H = Number(facts.currentAmount1) / 10 ** token1Info.decimals;

    const valueLp = curAmt0H * exitPrice + curAmt1H;
    const valueHold = entryAmt0H * exitPrice + entryAmt1H;
    const divergenceLoss = valueHold > 0 ? (valueLp - valueHold) / valueHold : 0;

    const fees0 = Number(facts.pendingFees0) / 10 ** token0Info.decimals;
    const fees1 = Number(facts.pendingFees1) / 10 ** token1Info.decimals;

    const feesValue = fees0 * exitPrice + fees1;
    const netPnl = valueLp - valueHold + feesValue;

    // Store snapshot
    insertSnapshot({
      token_id: pos.tokenId.toString(),
      timestamp: new Date().toISOString(),
      liquidity: pos.liquidity.toString(),
      current_sqrt_price_x96: poolState.sqrtPriceX96.toString(),
      current_tick: poolState.tick,
      current_amount0: curAmt0H.toString(),
      current_amount1: curAmt1H.toString(),
      entry_amount0: entryAmt0H.toString(),
      entry_amount1: entryAmt1H.toString(),
      value_lp: valueLp,
      value_hold: valueHold,
      divergence_loss: divergenceLoss,
      fees0,
      fees1,
      fees_value: feesValue,
      net_pnl: netPnl,
    });

    results.push({
      tokenId: pos.tokenId.toString(),
      saved: true,
      message: `Snapshot saved for #${pos.tokenId} (${token0Info.symbol}/${token1Info.symbol}) - DL: ${(divergenceLoss * 100).toFixed(4)}%`,
    });
  }

  return results;
}
