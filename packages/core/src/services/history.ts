import { getPosition, getSnapshots } from "../db/store.js";
import { sqrtPriceX96ToPrice } from "../math/divergence-loss.js";
import { NotFoundError } from "./errors.js";

export interface HistoryView {
  tokenId: string;
  pair: string;
  timestamp: string;
  currentPrice: number;
  divergenceLossPercent: number;
  fees0: number;
  fees1: number;
  feesValue: number;
  netPnl: number;
  valueLp: number;
  valueHold: number;
}

export async function getHistoryView(tokenId: string, limit?: number): Promise<HistoryView[]> {
  const storedPos = getPosition(tokenId);
  if (!storedPos) {
    throw new NotFoundError(`No stored data for position #${tokenId}. Run 'snapshot' first.`);
  }

  const snapshots = getSnapshots(tokenId, limit ?? 20);

  if (snapshots.length === 0) {
    throw new NotFoundError(`No snapshots found for position #${tokenId}. Run 'snapshot' first.`);
  }

  const pair = `${storedPos.token0_symbol}/${storedPos.token1_symbol}`;
  const decimals0 = storedPos.token0_decimals ?? 18;
  const decimals1 = storedPos.token1_decimals ?? 18;

  return snapshots.reverse().map((snap) => {
    const currentPrice = sqrtPriceX96ToPrice(
      BigInt(snap.current_sqrt_price_x96),
      decimals0,
      decimals1,
    );

    return {
      tokenId,
      pair,
      timestamp: snap.timestamp,
      currentPrice,
      divergenceLossPercent: snap.divergence_loss,
      fees0: snap.fees0,
      fees1: snap.fees1,
      feesValue: snap.fees_value,
      netPnl: snap.net_pnl,
      valueLp: snap.value_lp,
      valueHold: snap.value_hold,
    };
  });
}
