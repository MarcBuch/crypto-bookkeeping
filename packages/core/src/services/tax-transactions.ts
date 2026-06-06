import type { Config } from "../config.js";
import {
  getTaxSyncState,
  getTaxTransactionsNeedingEurEnrichment,
  updateTaxTransactionEurValues,
  upsertSyncedTaxTransaction,
  upsertTaxSyncState,
  type SyncedTaxTransaction,
} from "../db/store.js";
import { getHistoricalEurPrice } from "./pricing.js";
import { createClient, type Client } from "../chain/client.js";
import {
  createHyperSyncClient,
  fetchTransactionsByAddress,
  fetchTokenTransfersByAddress,
  type HyperSyncTransaction,
  type HyperSyncTokenTransfer,
} from "../chain/hypersync.js";
import { resolveTokenMetadata } from "../chain/token-metadata.js";
import type { HypersyncClient } from "@envio-dev/hypersync-client";

const DEFAULT_EXPLORER_API_URL = "https://www.hyperscan.com/api";
const DEFAULT_EXPLORER_CHAIN_ID = 999;
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_SOURCE = "hyperscan";

const TAX_EXPLORER_ACTIONS = ["txlist", "tokentx", "tokennfttx", "txlistinternal"] as const;

type TaxExplorerAction = (typeof TAX_EXPLORER_ACTIONS)[number];

type TaxTransactionFetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface SyncTaxTransactionsOptions {
  fetcher?: TaxTransactionFetcher;
  baseUrl?: string;
  pageSize?: number;
  maxPages?: number;
  source?: string;
  startBlock?: number;
  endBlock?: number;
  // Injectable clients for testing
  hyperSyncClient?: HypersyncClient;
  viemClient?: Client;
}

export interface SyncTaxTransactionsSummary {
  synced: number;
  insertedOrUpdated: number;
  source: string;
  wallet: string;
  latestBlockNumber: number | null;
}

interface ExplorerEnvelope {
  status?: string;
  message?: string;
  result?: unknown;
}

type ExplorerTransaction = Record<string, unknown>;

export async function syncTaxTransactions(
  config: Pick<Config, "wallet" | "tax" | "hyperSync" | "pricing" | "rpc" | "logsRpc" | "contracts" | "chainId">,
  options: SyncTaxTransactionsOptions = {},
): Promise<SyncTaxTransactionsSummary> {
  const wallet = config.wallet;
  const syncedAt = new Date().toISOString();
  const previousSyncState = getTaxSyncState(wallet);
  const fromBlock =
    previousSyncState?.last_block_number != null
      ? previousSyncState.last_block_number + 1
      : 0;

  let synced = 0;
  let latestBlockNumber: number | null = null;

  // ── HyperSync path: txlist + tokentx + tokennfttx ─────────────────────────
  const hyperSyncUrl =
    config.tax?.hyperSyncUrl ??
    config.hyperSync?.url ??
    "https://hyperliquid.hypersync.xyz";
  const hyperSyncApiToken =
    normalizedHyperSyncApiToken(config.tax?.hyperSyncApiToken) ??
    normalizedHyperSyncApiToken(config.hyperSync?.apiToken);

  if (!options.hyperSyncClient && !hyperSyncApiToken) {
    throw new Error(
      "Tax transaction sync requires tax.hyperSyncApiToken. " +
        "Get a free token at https://app.envio.dev/api-tokens and add it to your config.json.",
    );
  }

  const hyperSyncClient =
    options.hyperSyncClient ??
    createHyperSyncClient({ url: hyperSyncUrl, apiToken: hyperSyncApiToken! });
  const viemClient = options.viemClient ?? createClient(config as Config);

  // Fetch external transactions
  const txs = await fetchTransactionsByAddress(hyperSyncClient, wallet, fromBlock);
  for (const tx of txs) {
    const row = hyperSyncTxToSyncedTaxTransaction(tx, wallet, syncedAt);
    const [enriched] = await enrichTaxTransactionsWithEurValues([row], config);
    upsertSyncedTaxTransaction(enriched);
    synced += 1;
    if (row.block_number !== null) {
      latestBlockNumber = Math.max(latestBlockNumber ?? row.block_number, row.block_number);
    }
  }

  // Fetch token transfers
  const transfers = await fetchTokenTransfersByAddress(hyperSyncClient, wallet, fromBlock);
  for (const transfer of transfers) {
    const row = await hyperSyncTokenTransferToSyncedTaxTransaction(
      transfer,
      wallet,
      viemClient,
      syncedAt,
    );
    const [enriched] = await enrichTaxTransactionsWithEurValues([row], config);
    upsertSyncedTaxTransaction(enriched);
    synced += 1;
    if (row.block_number !== null) {
      latestBlockNumber = Math.max(latestBlockNumber ?? row.block_number, row.block_number);
    }
  }

  // ── Explorer fallback: txlistinternal only ─────────────────────────────────
  const explorerSynced = await syncInternalTransactions(config, options, wallet, fromBlock, syncedAt);
  synced += explorerSynced.synced;
  if (explorerSynced.latestBlockNumber !== null) {
    latestBlockNumber = Math.max(
      latestBlockNumber ?? explorerSynced.latestBlockNumber,
      explorerSynced.latestBlockNumber,
    );
  }

  // ── Update sync state watermark ────────────────────────────────────────────
  upsertTaxSyncState({
    wallet,
    last_synced_at: syncedAt,
    last_block_number: latestKnownBlockNumber(
      previousSyncState?.last_block_number ?? null,
      latestBlockNumber,
    ),
    source: "hypersync",
  });

  return { synced, insertedOrUpdated: synced, source: "hypersync", wallet, latestBlockNumber };
}

// ---------------------------------------------------------------------------
// HyperSync normalisation helpers
// ---------------------------------------------------------------------------

function hyperSyncTxToSyncedTaxTransaction(
  tx: HyperSyncTransaction,
  wallet: string,
  syncedAt: string,
): SyncedTaxTransaction {
  const hash = tx.hash;
  const gasUsed = tx.gasUsed.toString();
  const gasPrice = tx.gasPrice.toString();
  const value = tx.value.toString();
  const blockTimestamp = tx.blockTimestamp;
  const timeStamp = blockTimestamp ? new Date(blockTimestamp * 1000).toISOString() : null;

  const taxFields = taxLedgerFields({
    action: "txlist" as TaxExplorerAction,
    fromAddress: tx.from,
    toAddress: tx.to,
    value,
    tokenDecimal: 18, // native HYPE
    tokenSymbol: null, // will use "HYPE" fallback
    wallet,
  });

  return {
    id: `hypersync:txlist:${hash}:external`,
    hash,
    block_number: tx.blockNumber,
    time_stamp: timeStamp,
    from_address: tx.from,
    to_address: tx.to,
    value,
    gas_used: gasUsed,
    gas_price: gasPrice,
    fee: (tx.gasUsed * tx.gasPrice).toString(),
    method_id: tx.sighash,
    function_name: null,
    input: tx.input,
    contract_address: null,
    token_symbol: null,
    token_decimal: 18,
    token_name: null,
    transaction_type: "txlist",
    source: "hypersync",
    is_error: tx.status === 0 ? 1 : 0,
    ...taxFields,
    cost_eur: null,
    proceeds_eur: null,
    gain_eur: null,
    holding_duration_days: null,
    synced_at: syncedAt,
  };
}

async function hyperSyncTokenTransferToSyncedTaxTransaction(
  transfer: HyperSyncTokenTransfer,
  wallet: string,
  viemClient: Client,
  syncedAt: string,
): Promise<SyncedTaxTransaction> {
  // Resolve token metadata (uses DB cache)
  const metadata = await resolveTokenMetadata(viemClient, transfer.contractAddress);
  const tokenDecimal = metadata.decimals;
  const tokenSymbol = metadata.symbol;
  const tokenName = metadata.name;

  const value = transfer.value.toString();
  const timeStamp = transfer.blockTimestamp
    ? new Date(transfer.blockTimestamp * 1000).toISOString()
    : null;

  const action = (transfer.isNft ? "tokennfttx" : "tokentx") as TaxExplorerAction;
  const id = `hypersync:${action}:${transfer.transactionHash}:${transfer.logIndex}`;

  const taxFields = taxLedgerFields({
    action,
    fromAddress: transfer.from,
    toAddress: transfer.to,
    value,
    tokenDecimal,
    tokenSymbol,
    wallet,
  });

  return {
    id,
    hash: transfer.transactionHash,
    block_number: transfer.blockNumber,
    time_stamp: timeStamp,
    from_address: transfer.from,
    to_address: transfer.to,
    value,
    gas_used: null, // not available from log data
    gas_price: null,
    fee: null,
    method_id: null,
    function_name: null,
    input: null,
    contract_address: transfer.contractAddress,
    token_symbol: tokenSymbol,
    token_decimal: tokenDecimal,
    token_name: tokenName,
    transaction_type: action,
    source: "hypersync",
    is_error: 0,
    ...taxFields,
    cost_eur: null,
    proceeds_eur: null,
    gain_eur: null,
    holding_duration_days: null,
    synced_at: syncedAt,
  };
}

// ---------------------------------------------------------------------------
// Explorer fallback: txlistinternal only
// ---------------------------------------------------------------------------

async function syncInternalTransactions(
  config: Pick<Config, "wallet" | "tax" | "pricing">,
  options: SyncTaxTransactionsOptions,
  wallet: string,
  fromBlock: number,
  syncedAt: string,
): Promise<{ synced: number; latestBlockNumber: number | null }> {
  const source = options.source ?? DEFAULT_SOURCE;
  const baseUrl = options.baseUrl ?? config.tax?.explorerApiUrl ?? DEFAULT_EXPLORER_API_URL;
  const chainId = config.tax?.explorerChainId ?? DEFAULT_EXPLORER_CHAIN_ID;
  const apiKey = normalizedExplorerApiKey(config.tax?.explorerApiKey);
  const pageSize = positiveInteger(options.pageSize) ?? DEFAULT_PAGE_SIZE;
  const maxPages = positiveInteger(options.maxPages) ?? DEFAULT_MAX_PAGES;
  const fetcher = options.fetcher ?? fetch;

  if (requiresExplorerApiKey(baseUrl) && !apiKey) {
    throw new Error(
      "Tax transaction sync requires tax.explorerApiKey when using the Etherscan v2 explorer API",
    );
  }

  let synced = 0;
  let latestBlockNumber: number | null = null;

  const action: TaxExplorerAction = "txlistinternal";
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await fetchExplorerPage({
      action,
      address: wallet,
      apiKey,
      baseUrl,
      chainId,
      fetcher,
      page,
      pageSize,
      startBlock: options.startBlock ?? fromBlock,
      endBlock: options.endBlock,
    });

    if (response.length === 0) break;

    // Build rows for this page
    const pageRows: SyncedTaxTransaction[] = [];
    for (const item of response) {
      const row = toSyncedTaxTransaction({ action, item, wallet, source, syncedAt });
      if (row) pageRows.push(row);
    }

    // Batch-enrich with historical EUR values
    const enrichedRows = await enrichTaxTransactionsWithEurValues(pageRows, config);

    // Upsert each enriched row
    for (const row of enrichedRows) {
      upsertSyncedTaxTransaction(row);
      synced += 1;
      if (row.block_number !== null) {
        latestBlockNumber = Math.max(latestBlockNumber ?? row.block_number, row.block_number);
      }
    }

    if (response.length < pageSize) break;
  }

  return { synced, latestBlockNumber };
}

export async function enrichTaxTransactionsEurValues(
  config: Pick<Config, "tax" | "pricing">,
): Promise<{ enriched: number; skipped: number }> {
  let rows: ReturnType<typeof getTaxTransactionsNeedingEurEnrichment> = [];
  let enriched = 0;
  let skipped = 0;

  try {
    rows = getTaxTransactionsNeedingEurEnrichment();

    for (const row of rows) {
      const asset = row.asset_in ?? row.asset_out;

      if (!asset || !row.timestamp) {
        skipped += 1;
        continue;
      }

      const price = await getHistoricalEurPrice(config, asset, row.timestamp);

      if (price === null) {
        skipped += 1;
        continue;
      }

      const cost_eur = row.asset_out && row.qty_out ? String(Number(row.qty_out) * price) : null;
      const proceeds_eur = row.asset_in && row.qty_in ? String(Number(row.qty_in) * price) : null;

      let gain_eur: string | null;
      if (proceeds_eur !== null && cost_eur !== null) {
        gain_eur = String(Number(proceeds_eur) - Number(cost_eur));
      } else if (proceeds_eur !== null) {
        gain_eur = proceeds_eur;
      } else if (cost_eur !== null) {
        gain_eur = String(-Number(cost_eur));
      } else {
        gain_eur = null;
      }

      updateTaxTransactionEurValues(row.id, { cost_eur, proceeds_eur, gain_eur });
      enriched += 1;
    }
  } catch (err) {
    console.error("[enrichTaxTransactionsEurValues] unexpected error:", err);
    return { enriched, skipped: skipped + (rows.length - enriched - skipped) };
  }

  return { enriched, skipped };
}

async function enrichTaxTransactionsWithEurValues(
  rows: SyncedTaxTransaction[],
  config: Pick<Config, "pricing">,
): Promise<SyncedTaxTransaction[]> {
  const lookupKeys = new Set<string>();
  for (const row of rows) {
    if (!row.time_stamp) continue;
    if (row.incoming_asset) lookupKeys.add(`${row.incoming_asset}\0${row.time_stamp}`);
    if (row.outgoing_asset) lookupKeys.add(`${row.outgoing_asset}\0${row.time_stamp}`);
  }

  const priceMap = new Map<string, number | null>();
  await Promise.all(
    [...lookupKeys].map(async (key) => {
      const sep = key.indexOf("\0");
      const asset = key.slice(0, sep);
      const timestamp = key.slice(sep + 1);
      const price = await getHistoricalEurPrice(config, asset, timestamp);
      priceMap.set(key, price);
    }),
  );

  return rows.map((row) => {
    if (!row.time_stamp) return row;

    const incomingKey = row.incoming_asset ? `${row.incoming_asset}\0${row.time_stamp}` : null;
    const outgoingKey = row.outgoing_asset ? `${row.outgoing_asset}\0${row.time_stamp}` : null;

    const incomingPrice = incomingKey !== null ? (priceMap.get(incomingKey) ?? null) : null;
    const outgoingPrice = outgoingKey !== null ? (priceMap.get(outgoingKey) ?? null) : null;

    const incomingQty = row.incoming_quantity !== null ? Number(row.incoming_quantity) : null;
    const outgoingQty = row.outgoing_quantity !== null ? Number(row.outgoing_quantity) : null;

    const proceedsValue =
      incomingPrice !== null && incomingQty !== null && Number.isFinite(incomingQty)
        ? incomingQty * incomingPrice
        : null;
    const costValue =
      outgoingPrice !== null && outgoingQty !== null && Number.isFinite(outgoingQty)
        ? outgoingQty * outgoingPrice
        : null;

    // gain_eur treats the missing side as 0:
    //   incoming-only transfer: gain = proceeds - 0 = proceeds (acquisition value)
    //   outgoing-only transfer: gain = 0 - cost = -cost (disposal value)
    //   trade with both sides: gain = proceeds - cost (realised P&L)
    // null only when neither side has a EUR price (no data at all).
    const gainValue =
      proceedsValue !== null || costValue !== null ? (proceedsValue ?? 0) - (costValue ?? 0) : null;

    return {
      ...row,
      cost_eur: costValue !== null ? String(costValue) : null,
      proceeds_eur: proceedsValue !== null ? String(proceedsValue) : null,
      gain_eur: gainValue !== null ? String(gainValue) : null,
    };
  });
}

async function fetchExplorerPage(args: {
  action: TaxExplorerAction;
  address: string;
  apiKey?: string;
  baseUrl: string;
  chainId: number;
  fetcher: TaxTransactionFetcher;
  page: number;
  pageSize: number;
  startBlock?: number;
  endBlock?: number;
}): Promise<ExplorerTransaction[]> {
  const params = new URLSearchParams({
    chainid: String(args.chainId),
    module: "account",
    action: args.action,
    address: args.address,
    page: String(args.page),
    offset: String(args.pageSize),
    sort: "asc",
  });
  if (args.apiKey) params.set("apikey", args.apiKey);
  if (args.startBlock !== undefined) params.set("startblock", String(args.startBlock));
  if (args.endBlock !== undefined) params.set("endblock", String(args.endBlock));

  const separator = args.baseUrl.includes("?") ? "&" : "?";
  const url = `${args.baseUrl}${separator}${params.toString()}`;
  const response = await args.fetcher(url);
  if (!response.ok) {
    throw new Error(`Tax transaction sync failed for ${args.action}: HTTP ${response.status}`);
  }

  const body = (await response.json()) as ExplorerEnvelope;
  const result = body?.result;
  if (Array.isArray(result)) {
    return result.filter(isExplorerTransaction);
  }

  if (isExplorerEmptyOrUnsupported(body, args.action)) {
    return [];
  }

  throw new Error(`Tax transaction sync failed for ${args.action}: ${formatExplorerError(body)}`);
}

function toSyncedTaxTransaction(args: {
  action: TaxExplorerAction;
  item: ExplorerTransaction;
  wallet: string;
  source: string;
  syncedAt: string;
}): SyncedTaxTransaction | null {
  const hash = stringValue(args.item.hash ?? args.item.transactionHash);
  if (!hash) return null;

  const gasUsed = stringValue(args.item.gasUsed ?? args.item.gas);
  const gasPrice = stringValue(args.item.gasPrice);
  const blockNumber = integerValue(args.item.blockNumber);
  const value = stringValue(args.item.value);
  const fromAddress = stringValue(args.item.from);
  const toAddress = stringValue(args.item.to);
  const tokenSymbol = stringValue(args.item.tokenSymbol);
  const tokenDecimal = integerValue(args.item.tokenDecimal);
  const taxFields = taxLedgerFields({
    action: args.action,
    fromAddress,
    toAddress,
    value,
    tokenDecimal,
    tokenSymbol,
    wallet: args.wallet,
  });

  return {
    id: makeTaxTransactionId(args.source, args.action, hash, args.item),
    hash,
    block_number: blockNumber,
    time_stamp: timestampValue(args.item.timeStamp),
    from_address: fromAddress,
    to_address: toAddress,
    value,
    gas_used: gasUsed,
    gas_price: gasPrice,
    fee: calculateFee(gasUsed, gasPrice),
    method_id: stringValue(args.item.methodId),
    function_name: stringValue(args.item.functionName),
    input: stringValue(args.item.input),
    contract_address: stringValue(args.item.contractAddress),
    token_symbol: tokenSymbol,
    token_decimal: tokenDecimal,
    token_name: stringValue(args.item.tokenName),
    transaction_type: args.action,
    source: args.source,
    is_error: integerValue(args.item.isError),
    ...taxFields,
    cost_eur: null,
    proceeds_eur: null,
    gain_eur: null,
    holding_duration_days: null,
    synced_at: args.syncedAt,
  };
}

function taxLedgerFields(args: {
  action: TaxExplorerAction;
  fromAddress: string | null;
  toAddress: string | null;
  value: string | null;
  tokenDecimal: number | null;
  tokenSymbol: string | null;
  wallet: string;
}): Pick<
  SyncedTaxTransaction,
  "incoming_quantity" | "incoming_asset" | "outgoing_quantity" | "outgoing_asset"
> {
  const quantity = formatTaxQuantity(args.value, args.tokenDecimal ?? nativeDecimals(args.action));
  const asset = args.tokenSymbol ?? "HYPE";

  if (isSameAddress(args.toAddress, args.wallet)) {
    return {
      incoming_quantity: quantity,
      incoming_asset: asset,
      outgoing_quantity: null,
      outgoing_asset: null,
    };
  }

  if (isSameAddress(args.fromAddress, args.wallet)) {
    return {
      incoming_quantity: null,
      incoming_asset: null,
      outgoing_quantity: quantity,
      outgoing_asset: asset,
    };
  }

  return {
    incoming_quantity: null,
    incoming_asset: null,
    outgoing_quantity: null,
    outgoing_asset: null,
  };
}

function nativeDecimals(action: TaxExplorerAction): number | null {
  return action === "txlist" || action === "txlistinternal" ? 18 : null;
}

function isSameAddress(left: string | null, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

function formatTaxQuantity(value: string | null, decimals: number | null): string | null {
  if (!value) return null;
  if (decimals === null) return value;

  try {
    const parsed = BigInt(value);
    const divisor = 10n ** BigInt(decimals);
    const whole = parsed / divisor;
    const remainder = parsed % divisor;
    const decimal = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${whole.toString()}${decimal ? `.${decimal}` : ""}`;
  } catch {
    return value;
  }
}

function makeTaxTransactionId(
  source: string,
  action: TaxExplorerAction,
  hash: string,
  item: ExplorerTransaction,
): string {
  const discriminator = taxTransactionDiscriminator(action, item);
  return `${source}:${action}:${hash}:${discriminator}`;
}

function taxTransactionDiscriminator(action: TaxExplorerAction, item: ExplorerTransaction): string {
  if (action === "txlist") return "external";

  if (action === "tokentx" || action === "tokennfttx") {
    return (
      stringValue(item.logIndex) ??
      [
        "token",
        stringValue(item.contractAddress),
        stringValue(item.tokenID),
        stringValue(item.tokenName),
        stringValue(item.tokenSymbol),
        stringValue(item.value),
        stringValue(item.from),
        stringValue(item.to),
      ].join(":")
    );
  }

  return (
    stringValue(item.traceId) ??
    [
      "internal",
      stringValue(item.from),
      stringValue(item.to),
      stringValue(item.value),
      stringValue(item.contractAddress),
      stringValue(item.type),
    ].join(":")
  );
}

function latestKnownBlockNumber(
  previousBlockNumber: number | null,
  latestBlockNumber: number | null,
): number | null {
  if (previousBlockNumber === null) return latestBlockNumber;
  if (latestBlockNumber === null) return previousBlockNumber;
  return Math.max(previousBlockNumber, latestBlockNumber);
}

function calculateFee(gasUsed: string | null, gasPrice: string | null): string | null {
  if (!gasUsed || !gasPrice) return null;

  try {
    const gasUsedValue = BigInt(gasUsed);
    const gasPriceValue = BigInt(gasPrice);
    if (gasUsedValue < 0n || gasPriceValue < 0n) return null;
    return (gasUsedValue * gasPriceValue).toString();
  } catch {
    return null;
  }
}

function timestampValue(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) return null;

  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    if (Number.isSafeInteger(seconds)) return new Date(seconds * 1000).toISOString();
  }

  const millis = Date.parse(text);
  return Number.isNaN(millis) ? null : new Date(millis).toISOString();
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  return null;
}

function integerValue(value: unknown): number | null {
  const text = stringValue(value);
  if (!text || !/^-?\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

function normalizedHyperSyncApiToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "YOUR_HYPERSYNC_API_TOKEN") return undefined;
  return trimmed;
}

function normalizedExplorerApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "YOUR_ETHERSCAN_API_KEY") return undefined;
  if (trimmed === "YOUR_ETHERSCAN_API_KEY_OPTIONAL") return undefined;
  return trimmed;
}

function requiresExplorerApiKey(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === "api.etherscan.io" && url.pathname === "/v2/api";
  } catch {
    return false;
  }
}

function isExplorerTransaction(value: unknown): value is ExplorerTransaction {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExplorerEmptyOrUnsupported(body: ExplorerEnvelope, action: TaxExplorerAction): boolean {
  const message =
    `${body.message ?? ""} ${typeof body.result === "string" ? body.result : ""}`.toLowerCase();
  if (message.includes("no transactions found")) return true;
  if (action !== "txlistinternal") return false;
  return (
    message.includes("not supported") ||
    message.includes("unsupported") ||
    message.includes("invalid action")
  );
}

function formatExplorerError(body: ExplorerEnvelope): string {
  if (typeof body.result === "string" && body.result) return body.result;
  if (body.message) return body.message;
  return "unexpected explorer response";
}
