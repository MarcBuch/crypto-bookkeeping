export interface PositionView {
  tokenId: string;
  token0: { address: string; symbol: string; decimals: number };
  token1: { address: string; symbol: string; decimals: number };
  fee: number;
  feePercent: number;
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
  currentPrice: number;
  liquidity: string;
  status: "active" | "closed";
  inRange: boolean;
  currentAmount0: number;
  currentAmount1: number;
}

export interface PnLView {
  tokenId: string;
  pair: string;
  token0Symbol: string;
  token1Symbol: string;
  status: "active" | "closed";
  entryPrice: number;
  exitPrice: number;
  priceChangePercent: number;
  entryAmount0: number;
  entryAmount1: number;
  exitAmount0: number;
  exitAmount1: number;
  feesCollected0: number;
  feesCollected1: number;
  feesCollected0Usd?: number | null;
  feesCollected1Usd?: number | null;
  feesValueInToken1: number;
  feesValueUsd?: number | null;
  token0UsdPrice?: number | null;
  token1UsdPrice?: number | null;
  usdPriceSource?: "coingecko" | null;
  entryValueInToken1: number;
  exitValueInToken1: number;
  holdValueInToken1: number;
  absolutePnlInToken1: number;
  absolutePnlPercent: number;
  divergenceLossPercent: number;
  opportunityCostInToken1: number;
  netVsHodlPercent: number;
  priceLower: number;
  priceUpper: number;
}

export interface DashboardPosition extends PositionView {
  pnl?: PnLView;
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`);

  if (!response.ok) {
    const errorMessage = await readErrorMessage(response);
    throw new ApiError(errorMessage, response.status);
  }

  return response.json() as Promise<T>;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) {
      return body.error;
    }
  } catch {
    // Fall through to a stable generic message for non-JSON errors.
  }

  return `API request failed with status ${response.status}`;
}

export async function getPositions(): Promise<PositionView[]> {
  const data = await fetchJson<{ positions?: PositionView[] }>("/positions");

  if (!Array.isArray(data.positions)) {
    throw new ApiError("API response did not include positions.");
  }

  return data.positions;
}

export async function getPnL(): Promise<PnLView[]> {
  const data = await fetchJson<{ positions?: PnLView[] }>("/pnl");

  if (!Array.isArray(data.positions)) {
    throw new ApiError("API response did not include P&L positions.");
  }

  return data.positions;
}

export async function getDashboardPositions(): Promise<DashboardPosition[]> {
  const [positions, pnlPositions] = await Promise.all([getPositions(), getPnL()]);
  const pnlByTokenId = new Map(pnlPositions.map((pnl) => [pnl.tokenId, pnl]));

  return positions.map((position) => ({
    ...position,
    pnl: pnlByTokenId.get(position.tokenId),
  }));
}
