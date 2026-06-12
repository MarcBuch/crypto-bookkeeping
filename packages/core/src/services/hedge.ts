import type { Config } from "../config.js";
import { insertHedgeSnapshot } from "../db/store.js";

export interface HedgeView {
  tokenId: string;
  coin: string;
  szi: string; // e.g. "-30.1"
  entryPx: number;
  markPx: number;
  unrealizedPnl: number;
  fundingEarned: number; // cumFunding.sinceOpen, positive when short earns
  liquidationPx: number | null;
  leverage: { type: string; value: number };
}

interface HyperliquidPosition {
  position: {
    coin: string;
    szi: string;
    entryPx: string;
    positionValue: string;
    unrealizedPnl: string;
    cumFunding?: {
      sinceOpen?: string;
    };
    leverage: { type: string; value: number };
    liquidationPx: string;
    markPx: string;
  };
  type: string;
}

interface HyperliquidClearinghouseState {
  assetPositions: HyperliquidPosition[];
}

export async function getHedgeView(config: Config, tokenId: string): Promise<HedgeView> {
  // Read hedge config for this position
  const hedgeConfig = config.positions?.[tokenId]?.hedge;
  if (!hedgeConfig) {
    throw new Error(
      `Position #${tokenId} does not have a hedge configuration. ` +
        `Add "hedge": { "coin": "HYPE" } to config.positions[${tokenId}]`,
    );
  }

  const coin = hedgeConfig.coin;

  // Fetch clearinghouse state from Hyperliquid
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "clearinghouseState",
      user: config.wallet,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Hyperliquid API error (${response.status}): ${response.statusText} ` +
        `when fetching clearinghouse state for wallet ${config.wallet}`,
    );
  }

  const data = (await response.json()) as HyperliquidClearinghouseState;

  // Guard against missing assetPositions
  if (!data.assetPositions) {
    throw new Error(
      `Hyperliquid API response missing assetPositions for wallet ${config.wallet}. ` +
        `Response structure may have changed.`,
    );
  }

  // Find the position matching the configured coin
  const position = data.assetPositions.find((ap) => ap.position.coin === coin);

  if (!position) {
    throw new Error(
      `No open ${coin} position found on Hyperliquid for wallet ${config.wallet}. ` +
        `Available positions: ${data.assetPositions.map((ap) => ap.position.coin).join(", ") || "none"}`,
    );
  }

  // Check if position is closed (szi === 0)
  const szi = parseFloat(position.position.szi);
  if (szi === 0) {
    throw new Error(
      `${coin} position is closed (szi=0) for wallet ${config.wallet}. ` +
        `Cannot create hedge view for a closed position.`,
    );
  }

  // Parse all numeric fields
  const entryPx = parseFloat(position.position.entryPx);
  const markPx = parseFloat(position.position.markPx);
  const unrealizedPnl = parseFloat(position.position.unrealizedPnl);
  const fundingEarned = parseFloat(position.position.cumFunding?.sinceOpen ?? "0");
  const liquidationPx = parseFloat(position.position.liquidationPx);

  return {
    tokenId,
    coin,
    szi: position.position.szi,
    entryPx,
    markPx,
    unrealizedPnl,
    fundingEarned,
    liquidationPx: isNaN(liquidationPx) ? null : liquidationPx,
    leverage: position.position.leverage,
  };
}

export function snapshotHedge(view: HedgeView): void {
  insertHedgeSnapshot({
    token_id: view.tokenId,
    coin: view.coin,
    szi: view.szi,
    entry_px: view.entryPx,
    mark_px: view.markPx,
    unrealized_pnl: view.unrealizedPnl,
    funding_earned: view.fundingEarned,
    liquidation_px: view.liquidationPx,
  });
}
