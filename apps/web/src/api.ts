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
  hedge?: {
    coin: string;
  };
}

export interface PnLView {
  tokenId: string;
  pair: string;
  token0Symbol: string;
  token1Symbol: string;
  openedAt?: string | null;
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
  pendingFeesValueInToken1: number;
  pendingFeesValueUsd?: number | null;
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

export interface HedgeView {
  tokenId: string;
  coin: string;
  szi: string;
  entryPx: number;
  markPx: number;
  unrealizedPnl: number;
  fundingEarned: number;
  liquidationPx: number | null;
  leverage: { type: string; value: number };
  status: "active" | "closed";
  realizedPnl?: number | null;
  closedAt?: string | null;
  closeReason?: string | null;
  stale?: boolean;
}

export interface HedgeEvent {
  id: number;
  token_id: string | null;
  trade_key: string | null;
  tax_key: string | null;
  coin: string;
  status: "open" | "closed";
  entry_px: number;
  size: number;
  opened_at: string;
  closed_at: string | null;
  close_px: number | null;
  realized_pnl: number | null;
  funding_earned: number | null;
  close_reason: string | null;
  hl_fill_hash: string | null;
  current_szi: string | null;
  mark_px: number | null;
  unrealized_pnl: number | null;
  liquidation_px: number | null;
  leverage_type: string | null;
  leverage_value: number | null;
  updated_at: string | null;
}

export type HedgesAssignedFilter = "assigned" | "unassigned" | "all";

export type TaxTransactionLabel = "Trade" | "Transfer" | "Approval" | "Repay Loan" | null;

export interface TaxTransaction {
  id: string;
  hash: string;
  block_number: number | null;
  time_stamp: string | null;
  from_address: string | null;
  to_address: string | null;
  value: string | null;
  gas_used: string | null;
  gas_price: string | null;
  fee: string | null;
  method_id: string | null;
  function_name: string | null;
  input: string | null;
  contract_address: string | null;
  token_symbol: string | null;
  token_decimal: number | null;
  token_name: string | null;
  transaction_type: string | null;
  source: string;
  is_error: number | null;
  label: TaxTransactionLabel;
  incoming_quantity: string | null;
  incoming_asset: string | null;
  outgoing_quantity: string | null;
  outgoing_asset: string | null;
  cost_eur: string | null;
  proceeds_eur: string | null;
  gain_eur: string | null;
  holding_duration_days: number | null;
  comment: string | null;
  synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface TaxSyncSummary {
  synced?: number;
  insertedOrUpdated?: number;
  source?: string;
  wallet?: string;
  latestBlockNumber?: number | null;
  [key: string]: unknown;
}

export interface TaxTransactionsOptions {
  limit?: number;
  offset?: number;
  label?: TaxTransactionLabel;
}

export interface TaxTransactionsPagination {
  limit: number;
  offset: number;
  label: TaxTransactionLabel;
  total: number;
}

export interface TaxTransactionsResponse {
  transactions: TaxTransaction[];
  pagination: TaxTransactionsPagination;
}

export interface TaxTransactionUpdate {
  hash?: string;
  block_number?: number | null;
  time_stamp?: string | null;
  from_address?: string | null;
  to_address?: string | null;
  value?: string | null;
  gas_used?: string | null;
  gas_price?: string | null;
  fee?: string | null;
  method_id?: string | null;
  function_name?: string | null;
  input?: string | null;
  contract_address?: string | null;
  token_symbol?: string | null;
  token_decimal?: number | null;
  token_name?: string | null;
  is_error?: number | null;
  label?: TaxTransactionLabel;
  incoming_quantity?: string | null;
  incoming_asset?: string | null;
  outgoing_quantity?: string | null;
  outgoing_asset?: string | null;
  cost_eur?: string | null;
  proceeds_eur?: string | null;
  gain_eur?: string | null;
  holding_duration_days?: number | null;
  comment?: string | null;
}

export interface ManualTaxTransactionCreateInput {
  id?: string;
  hash?: string;
  block_number?: number | null;
  time_stamp?: string | null;
  from_address?: string | null;
  to_address?: string | null;
  value?: string | null;
  gas_used?: string | null;
  gas_price?: string | null;
  label?: TaxTransactionLabel;
  comment?: string | null;
  incoming_quantity?: string | null;
  incoming_asset?: string | null;
  outgoing_quantity?: string | null;
  outgoing_asset?: string | null;
  fee?: string | null;
  method_id?: string | null;
  function_name?: string | null;
  input?: string | null;
  contract_address?: string | null;
  token_symbol?: string | null;
  token_decimal?: number | null;
  token_name?: string | null;
  is_error?: number | null;
  cost_eur?: string | null;
  proceeds_eur?: string | null;
  gain_eur?: string | null;
  holding_duration_days?: number | null;
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

interface FetchJsonOptions {
  method?: string;
  body?: unknown;
}

async function readJson<T>(response: Response): Promise<T> {
  return await response.json();
}

async function fetchJson<T>(path: string, options: FetchJsonOptions = {}): Promise<T> {
  const init: RequestInit = {};

  if (options.method) {
    init.method = options.method;
  }

  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { "content-type": "application/json" };
  }

  const response = await fetch(`${apiBaseUrl}${path}`, init);

  if (!response.ok) {
    const errorMessage = await readErrorMessage(response);
    throw new ApiError(errorMessage, response.status);
  }

  return await readJson<T>(response);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTaxTransaction(value: unknown): value is TaxTransaction {
  return isObject(value) && typeof value.id === "string" && typeof value.hash === "string";
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = await readJson<unknown>(response);
    if (isObject(body) && typeof body.error === "string" && body.error.length > 0) {
      return body.error;
    }
  } catch {
    // Fall through to a stable generic message for non-JSON errors.
  }

  return `API request failed with status ${response.status}`;
}

export type SyncStatus = {
  status: "idle" | "running" | "completed" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  positionCount: number | null;
};

export async function getPositions(): Promise<{
  positions: PositionView[];
  syncedAt: string | null;
}> {
  const data = await fetchJson<{ positions?: PositionView[]; syncedAt?: string | null }>(
    "/positions",
  );

  if (!Array.isArray(data.positions)) {
    throw new ApiError("API response did not include positions.");
  }

  return { positions: data.positions, syncedAt: data.syncedAt ?? null };
}

export async function getPnL(): Promise<{ positions: PnLView[]; syncedAt: string | null }> {
  const data = await fetchJson<{ positions?: PnLView[]; syncedAt?: string | null }>("/pnl");

  if (!Array.isArray(data.positions)) {
    throw new ApiError("API response did not include P&L positions.");
  }

  return { positions: data.positions, syncedAt: data.syncedAt ?? null };
}

export async function syncPositions(): Promise<{ message: string }> {
  const data = await fetchJson<{ message: string }>("/positions/sync", { method: "POST" });
  return data;
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const data = await fetchJson<SyncStatus>("/positions/sync/status");
  return data;
}

export async function syncSinglePosition(tokenId: string): Promise<{ message: string }> {
  const data = await fetchJson<{ message: string }>(`/positions/${tokenId}/sync`, {
    method: "POST",
  });
  return data;
}

export async function getSinglePositionSyncStatus(tokenId: string): Promise<SyncStatus> {
  const data = await fetchJson<SyncStatus>(`/positions/${tokenId}/sync/status`);
  return data;
}

export async function getDashboardPositions(): Promise<{
  positions: DashboardPosition[];
  syncedAt: string | null;
}> {
  const [{ positions, syncedAt }, { positions: pnlPositions }] = await Promise.all([
    getPositions(),
    getPnL(),
  ]);
  const pnlByTokenId = new Map(pnlPositions.map((pnl) => [pnl.tokenId, pnl]));

  return {
    positions: positions.map((position) => ({
      ...position,
      pnl: pnlByTokenId.get(position.tokenId),
    })),
    syncedAt,
  };
}

export async function getTaxTransactions(
  options: TaxTransactionsOptions = {},
): Promise<TaxTransactionsResponse> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set("limit", options.limit.toString());
  }
  if (options.offset !== undefined) {
    params.set("offset", options.offset.toString());
  }
  if (options.label !== undefined && options.label !== null) {
    params.set("label", options.label);
  }

  const query = params.toString();
  const data = await fetchJson<{
    transactions?: unknown;
    pagination?: unknown;
  }>(
    `/tax/transactions${query ? `?${query}` : ""}`,
  );

  if (!Array.isArray(data.transactions)) {
    throw new ApiError("API response did not include tax transactions.");
  }

  if (!data.transactions.every(isTaxTransaction)) {
    throw new ApiError("API response included malformed tax transactions.");
  }

  if (!isObject(data.pagination)) {
    throw new ApiError("API response did not include tax transactions pagination.");
  }

  const { limit, offset, label, total } = data.pagination;
  if (
    typeof limit !== "number" ||
    typeof offset !== "number" ||
    typeof total !== "number" ||
    (
      label !== null &&
      label !== "Trade" &&
      label !== "Transfer" &&
      label !== "Approval" &&
      label !== "Repay Loan"
    )
  ) {
    throw new ApiError("API response included malformed tax transactions pagination.");
  }

  return {
    transactions: data.transactions,
    pagination: { limit, offset, label, total },
  };
}

export async function syncTaxTransactions(): Promise<TaxSyncSummary> {
  const data = await fetchJson<{ sync?: unknown }>("/tax/transactions/sync", { method: "POST" });

  if (!isObject(data.sync)) {
    throw new ApiError("API response did not include tax sync summary.");
  }

  return data.sync as TaxSyncSummary;
}

export async function createTaxTransaction(
  input: ManualTaxTransactionCreateInput,
): Promise<TaxTransaction> {
  const data = await fetchJson<{ transaction?: unknown }>("/tax/transactions", {
    method: "POST",
    body: input,
  });

  if (!isObject(data.transaction)) {
    throw new ApiError("API response did not include tax transaction.");
  }

  if (!isTaxTransaction(data.transaction)) {
    throw new ApiError("API response included malformed tax transaction.");
  }

  return data.transaction;
}

export async function updateTaxTransaction(
  id: string,
  update: TaxTransactionUpdate,
): Promise<TaxTransaction> {
  const data = await fetchJson<{ transaction?: unknown }>(
    `/tax/transactions/${encodeURIComponent(id)}`,
    { method: "PATCH", body: update },
  );

  if (!isObject(data.transaction)) {
    throw new ApiError("API response did not include tax transaction.");
  }

  if (!isTaxTransaction(data.transaction)) {
    throw new ApiError("API response included malformed tax transaction.");
  }

  return data.transaction;
}

export async function getHedge(tokenId: string): Promise<HedgeView> {
  const data = await fetchJson<HedgeView>(`/positions/${tokenId}/hedge`);
  return data;
}

export async function getHedgeEvents(tokenId: string): Promise<HedgeEvent[]> {
  const data = await fetchJson<{ events?: HedgeEvent[]; tokenId?: string }>(
    `/positions/${tokenId}/hedge/events`,
  );
  if (!Array.isArray(data.events)) {
    throw new ApiError("API response did not include events.");
  }
  return data.events;
}

export async function getHedges(
  options: { assigned?: HedgesAssignedFilter } = {},
): Promise<{ hedges: HedgeEvent[] }> {
  const params = new URLSearchParams();
  if (options.assigned) {
    params.set("assigned", options.assigned);
  }

  const query = params.toString();
  const data = await fetchJson<{ hedges?: HedgeEvent[] }>(`/hedges${query ? `?${query}` : ""}`);

  if (!Array.isArray(data.hedges)) {
    throw new ApiError("API response did not include hedges.");
  }

  return { hedges: data.hedges };
}

export async function assignHedgeEvent(id: number, tokenId: string | null): Promise<{ hedge: HedgeEvent }> {
  const data = await fetchJson<{ hedge?: HedgeEvent }>(`/hedges/${id}/assignment`, {
    method: "PATCH",
    body: { tokenId },
  });

  if (!isObject(data.hedge)) {
    throw new ApiError("API response did not include hedge.");
  }

  return { hedge: data.hedge as HedgeEvent };
}
