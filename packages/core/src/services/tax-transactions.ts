import { createClient, type Client } from "../chain/client.js";
import {
  createHyperSyncClient,
  DEFAULT_HYPERSYNC_URL,
  fetchTransactionsByAddress,
  fetchTokenTransfersByAddress,
  type HyperSyncTransaction,
  type HyperSyncTokenTransfer,
  type HypersyncClient,
} from "../chain/hypersync.js";
import { resolveTokenMetadata, type TokenMetadataClient } from "../chain/token-metadata.js";
import type { Config } from "../config.js";
import { createHedgeStore } from "../db/hedge-store.js";
import {
  closeHedgeEvent,
  createManualTaxTransaction,
  countTaxTransactions,
  getAllClosedHedgeEvents,
  getAllPositions,
  getEarliestHedgeSnapshot,
  getHedgeEvents,
  getOpenHedgeEvent,
  getTaxSyncState,
  getTaxTransaction,
  getTaxTransactionsNeedingEurEnrichment,
  getTaxTransactionsNeedingGermanTaxReview,
  insertHedgeEvent,
  insertHedgeSnapshot,
  listGermanTaxableTransactions,
  listHedgeSnapshots,
  listTaxTransactions,
  updateTaxTransaction,
  updateTaxTransactionEurValues,
  upsertSyncedTaxTransaction,
  upsertTaxSyncState,
  type StoredPosition,
  type StoredHedgeEvent,
  type SyncedTaxTransaction,
} from "../db/store.js";
import { createTaxLedgerStore } from "../db/tax-ledger-store.js";
import { getHistoricalPrice } from "./pricing.js";

function getTaxLedgerStore() {
  return createTaxLedgerStore({
    createManualTaxTransaction,
    countTaxTransactions,
    getTaxSyncState,
    getTaxTransaction,
    getTaxTransactionsNeedingEurEnrichment,
    getTaxTransactionsNeedingGermanTaxReview,
    listGermanTaxableTransactions,
    listTaxTransactions,
    updateTaxTransaction,
    updateTaxTransactionEurValues,
    upsertSyncedTaxTransaction,
    upsertTaxSyncState,
  });
}

function getHedgeStore() {
  return createHedgeStore({
    closeHedgeEvent,
    getAllClosedHedgeEvents,
    getEarliestHedgeSnapshot,
    getHedgeEvents,
    getOpenHedgeEvent,
    insertHedgeEvent,
    insertHedgeSnapshot,
    listHedgeSnapshots,
  });
}

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

interface ExplorerEnvelope {
  status?: string;
  message?: string;
  result?: unknown;
}

type ExplorerTransaction = Record<string, unknown>;
type BlockClient = Pick<Client, "getBlock">;

export interface SyncLpTaxFlowsOptions {
  viemClient?: BlockClient;
}

export interface SyncLpTaxFlowsSummary {
  synced: number;
  skipped: number;
}

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
  viemClient?: TokenMetadataClient & Partial<BlockClient>;
}

export interface SyncTaxTransactionsSummary {
  synced: number;
  insertedOrUpdated: number;
  source: string;
  wallet: string;
  latestBlockNumber: number | null;
  /** Number of tax rows written (1–2 per hedge event) not events */
  hedgeFlowsSynced: number;
}

export async function syncLpTaxFlows(
  config: Pick<Config, "wallet" | "pricing" | "rpc" | "chainId" | "contracts">,
  options: SyncLpTaxFlowsOptions = {},
): Promise<SyncLpTaxFlowsSummary> {
  const taxLedgerStore = getTaxLedgerStore();
  const viemClient = options.viemClient ?? createClient(config);
  const syncedAt = new Date().toISOString();
  const positions = getAllPositions();

  // Build a map of unique block numbers → timestamps
  const blockNumbers = new Set<number>();
  for (const pos of positions) {
    if (pos.entry_block !== null && pos.entry_block !== undefined)
      blockNumbers.add(pos.entry_block);
    if (pos.close_block !== null && pos.close_block !== undefined)
      blockNumbers.add(pos.close_block);
  }

  const blockTimestampMap = new Map<number, number | null>();
  for (const blockNum of blockNumbers) {
    try {
      const block = await viemClient.getBlock({ blockNumber: BigInt(blockNum) });
      blockTimestampMap.set(blockNum, block.timestamp ? Number(block.timestamp) : null);
    } catch {
      blockTimestampMap.set(blockNum, null);
    }
  }

  let synced = 0;
  let skipped = 0;

  for (const position of positions) {
    // ── Deposit entries ────────────────────────────────────────────────────
    if (position.open_tx) {
      const hasEntry =
        (position.entry_amount0 !== null && position.entry_amount0 !== "0") ||
        (position.entry_amount1 !== null && position.entry_amount1 !== "0");
      if (hasEntry && position.entry_block !== null) {
        // Token0
        if (position.entry_amount0 !== null && position.entry_amount0 !== "0") {
          const depositEntry = buildLpDepositEntry(
            position,
            0,
            position.open_tx,
            position.entry_block,
            blockTimestampMap,
            config.wallet,
            config.contracts.positionManager,
            syncedAt,
          );
          const [enriched] = await enrichTaxTransactionsWithEurValues([depositEntry], config);
          taxLedgerStore.upsertSyncedTransaction(enriched);
          synced += 1;
        }

        // Token1
        if (position.entry_amount1 !== null && position.entry_amount1 !== "0") {
          const depositEntry = buildLpDepositEntry(
            position,
            1,
            position.open_tx,
            position.entry_block,
            blockTimestampMap,
            config.wallet,
            config.contracts.positionManager,
            syncedAt,
          );
          const [enriched] = await enrichTaxTransactionsWithEurValues([depositEntry], config);
          taxLedgerStore.upsertSyncedTransaction(enriched);
          synced += 1;
        }
      } else {
        skipped += 1;
      }
    }

    // ── Withdrawal entries ─────────────────────────────────────────────────
    if (position.close_tx && position.close_block !== null) {
      const hasExit =
        (position.exit_amount0 !== null && position.exit_amount0 !== "0") ||
        (position.exit_amount1 !== null && position.exit_amount1 !== "0");

      if (hasExit) {
        // Token0
        if (position.exit_amount0 !== null && position.exit_amount0 !== "0") {
          const withdrawalEntry = buildLpWithdrawalEntry(
            position,
            0,
            position.close_tx,
            position.close_block,
            blockTimestampMap,
            syncedAt,
          );
          const [enriched] = await enrichTaxTransactionsWithEurValues([withdrawalEntry], config);
          taxLedgerStore.upsertSyncedTransaction(enriched);
          synced += 1;
        }

        // Token1
        if (position.exit_amount1 !== null && position.exit_amount1 !== "0") {
          const withdrawalEntry = buildLpWithdrawalEntry(
            position,
            1,
            position.close_tx,
            position.close_block,
            blockTimestampMap,
            syncedAt,
          );
          const [enriched] = await enrichTaxTransactionsWithEurValues([withdrawalEntry], config);
          taxLedgerStore.upsertSyncedTransaction(enriched);
          synced += 1;
        }
      }
    }

    // ── Fee entries ────────────────────────────────────────────────────────
    if (position.close_tx && position.close_block !== null) {
      const hasFees =
        (position.fees_collected0 !== null && position.fees_collected0 !== "0") ||
        (position.fees_collected1 !== null && position.fees_collected1 !== "0");

      if (hasFees) {
        // Token0
        if (position.fees_collected0 !== null && position.fees_collected0 !== "0") {
          const feeEntry = buildLpFeeEntry(
            position,
            0,
            position.close_tx,
            position.close_block,
            blockTimestampMap,
            syncedAt,
          );
          const [enriched] = await enrichTaxTransactionsWithEurValues([feeEntry], config);
          taxLedgerStore.upsertSyncedTransaction(enriched);
          synced += 1;
        }

        // Token1
        if (position.fees_collected1 !== null && position.fees_collected1 !== "0") {
          const feeEntry = buildLpFeeEntry(
            position,
            1,
            position.close_tx,
            position.close_block,
            blockTimestampMap,
            syncedAt,
          );
          const [enriched] = await enrichTaxTransactionsWithEurValues([feeEntry], config);
          taxLedgerStore.upsertSyncedTransaction(enriched);
          synced += 1;
        }
      }
    }
  }

  return { synced, skipped };
}

function buildLpDepositEntry(
  position: StoredPosition,
  tokenIndex: 0 | 1,
  hash: string,
  blockNumber: number | undefined,
  blockTimestampMap: Map<number, number | null>,
  wallet: string,
  positionManager: string,
  syncedAt: string,
): SyncedTaxTransaction {
  const token0 = tokenIndex === 0;
  const tokenAddress = token0 ? position.token0 : position.token1;
  const tokenSymbol = token0 ? position.token0_symbol : position.token1_symbol;
  const tokenDecimals = token0 ? position.token0_decimals : position.token1_decimals;
  const amount = token0 ? position.entry_amount0 : position.entry_amount1;
  const quantity = formatTaxQuantity(amount, tokenDecimals);
  const timeStamp =
    blockNumber !== undefined && blockNumber !== null ? blockTimestampMap.get(blockNumber) : null;
  const timeStampIso = timeStamp ? new Date(timeStamp * 1000).toISOString() : null;

  return {
    id: `lp:deposit:${hash}:${tokenAddress}:${tokenIndex}`,
    hash,
    block_number: blockNumber ?? null,
    time_stamp: timeStampIso,
    from_address: wallet,
    to_address: positionManager,
    value: amount,
    gas_used: null,
    gas_price: null,
    fee: null,
    method_id: null,
    function_name: null,
    input: null,
    contract_address: tokenAddress,
    token_symbol: tokenSymbol,
    token_decimal: tokenDecimals,
    token_name: null,
    transaction_type: "lp-deposit",
    source: "lp-events",
    is_error: 0,
    incoming_quantity: null,
    incoming_asset: null,
    outgoing_quantity: quantity,
    outgoing_asset: tokenSymbol,
    cost_eur: null,
    proceeds_eur: null,
    gain_eur: null,
    holding_duration_days: null,
    synced_at: syncedAt,
  };
}

function buildLpWithdrawalEntry(
  position: StoredPosition,
  tokenIndex: 0 | 1,
  hash: string,
  blockNumber: number | undefined,
  blockTimestampMap: Map<number, number | null>,
  syncedAt: string,
): SyncedTaxTransaction {
  const token0 = tokenIndex === 0;
  const tokenAddress = token0 ? position.token0 : position.token1;
  const tokenSymbol = token0 ? position.token0_symbol : position.token1_symbol;
  const tokenDecimals = token0 ? position.token0_decimals : position.token1_decimals;
  const amount = (token0 ? position.exit_amount0 : position.exit_amount1) ?? null;
  const quantity = formatTaxQuantity(amount, tokenDecimals);
  const timeStamp =
    blockNumber !== undefined && blockNumber !== null ? blockTimestampMap.get(blockNumber) : null;
  const timeStampIso = timeStamp ? new Date(timeStamp * 1000).toISOString() : null;

  return {
    id: `lp:withdrawal:${hash}:${tokenAddress}:${tokenIndex}`,
    hash,
    block_number: blockNumber ?? null,
    time_stamp: timeStampIso,
    from_address: null,
    to_address: null,
    value: amount,
    gas_used: null,
    gas_price: null,
    fee: null,
    method_id: null,
    function_name: null,
    input: null,
    contract_address: tokenAddress,
    token_symbol: tokenSymbol,
    token_decimal: tokenDecimals,
    token_name: null,
    transaction_type: "lp-withdrawal",
    source: "lp-events",
    is_error: 0,
    incoming_quantity: quantity,
    incoming_asset: tokenSymbol,
    outgoing_quantity: null,
    outgoing_asset: null,
    cost_eur: null,
    proceeds_eur: null,
    gain_eur: null,
    holding_duration_days: null,
    synced_at: syncedAt,
  };
}

function buildLpFeeEntry(
  position: StoredPosition,
  tokenIndex: 0 | 1,
  hash: string,
  blockNumber: number | undefined,
  blockTimestampMap: Map<number, number | null>,
  syncedAt: string,
): SyncedTaxTransaction {
  const token0 = tokenIndex === 0;
  const tokenAddress = token0 ? position.token0 : position.token1;
  const tokenSymbol = token0 ? position.token0_symbol : position.token1_symbol;
  const tokenDecimals = token0 ? position.token0_decimals : position.token1_decimals;
  const amount = (token0 ? position.fees_collected0 : position.fees_collected1) ?? null;
  const quantity = formatTaxQuantity(amount, tokenDecimals);
  const timeStamp =
    blockNumber !== undefined && blockNumber !== null ? blockTimestampMap.get(blockNumber) : null;
  const timeStampIso = timeStamp ? new Date(timeStamp * 1000).toISOString() : null;

  return {
    id: `lp:fees:${hash}:${tokenAddress}:${tokenIndex}`,
    hash,
    block_number: blockNumber ?? null,
    time_stamp: timeStampIso,
    from_address: null,
    to_address: null,
    value: amount,
    gas_used: null,
    gas_price: null,
    fee: null,
    method_id: null,
    function_name: null,
    input: null,
    contract_address: tokenAddress,
    token_symbol: tokenSymbol,
    token_decimal: tokenDecimals,
    token_name: null,
    transaction_type: "lp-fees",
    source: "lp-events",
    is_error: 0,
    incoming_quantity: quantity,
    incoming_asset: tokenSymbol,
    outgoing_quantity: null,
    outgoing_asset: null,
    cost_eur: null,
    proceeds_eur: null,
    gain_eur: null,
    holding_duration_days: null,
    synced_at: syncedAt,
  };
}

export function buildHedgeTaxEntries(
  event: StoredHedgeEvent,
  syncedAt: string,
): SyncedTaxTransaction[] {
  // id discriminator: prefer hl_fill_hash, fall back to evt{id}
  const disc = event.hl_fill_hash != null ? event.hl_fill_hash : `evt${event.id}`;
  const timeStamp = event.closed_at ?? null;

  const entries: SyncedTaxTransaction[] = [];

  // Base entry with common fields shared by close and funding rows
  const baseEntry = {
    block_number: null,
    time_stamp: timeStamp,
    from_address: null,
    to_address: null,
    value: null,
    gas_used: null,
    gas_price: null,
    fee: null,
    method_id: null,
    function_name: null,
    input: null,
    contract_address: null,
    token_symbol: "USDC" as const,
    token_decimal: 6,
    token_name: "USD Coin",
    source: "hedge-events",
    is_error: 0,
    holding_duration_days: null,
    synced_at: syncedAt,
  } satisfies Partial<SyncedTaxTransaction>;

  // --- close row (realized P&L) ---
  const pnl = event.realized_pnl ?? 0;
  const absPnl = Math.abs(pnl).toFixed(8);
  const closeEntry: SyncedTaxTransaction = {
    ...baseEntry,
    id: `hedge:close:${event.token_id}:${event.coin}:${disc}`,
    hash: event.hl_fill_hash ?? `hedge:close:${event.token_id}:${event.coin}:${disc}`,
    transaction_type: "hedge-close",
    incoming_quantity: pnl > 0 ? absPnl : null,
    incoming_asset: pnl > 0 ? "USDC" : null,
    outgoing_quantity: pnl < 0 ? absPnl : null,
    outgoing_asset: pnl < 0 ? "USDC" : null,
    cost_eur: pnl === 0 ? "0" : null,
    proceeds_eur: pnl === 0 ? "0" : null,
    gain_eur: pnl === 0 ? "0" : null,
  };
  entries.push(closeEntry);

  // --- funding row (only when non-zero) ---
  const funding = event.funding_earned ?? 0;
  if (funding !== 0) {
    const absFunding = Math.abs(funding).toFixed(8);
    const fundingEntry: SyncedTaxTransaction = {
      ...baseEntry,
      id: `hedge:funding:${event.token_id}:${event.coin}:${disc}:funding`,
      hash: `${event.hl_fill_hash ?? `hedge:funding:${event.token_id}:${event.coin}:${disc}`}:funding`,
      transaction_type: "hedge-funding",
      incoming_quantity: funding > 0 ? absFunding : null,
      incoming_asset: funding > 0 ? "USDC" : null,
      outgoing_quantity: funding < 0 ? absFunding : null,
      outgoing_asset: funding < 0 ? "USDC" : null,
      cost_eur: null,
      proceeds_eur: null,
      gain_eur: null,
    };
    entries.push(fundingEntry);
  }

  return entries;
}

export async function syncHedgeTaxFlows(
  config: Pick<Config, "pricing">,
  options: { syncedAt?: string } = {},
): Promise<{ synced: number }> {
  const syncedAt = options.syncedAt ?? new Date().toISOString();
  const taxLedgerStore = getTaxLedgerStore();
  const hedgeStore = getHedgeStore();
  const closedEvents = hedgeStore.listClosedEvents();
  let synced = 0;
  for (const event of closedEvents) {
    const entries = buildHedgeTaxEntries(event, syncedAt);
    for (const entry of entries) {
      // Already enriched in DB — skip pricing API, upsert as-is
      const existing = taxLedgerStore.getTransaction(entry.id);
      const alreadyEnriched =
        existing !== null && (existing.cost_eur !== null || existing.proceeds_eur !== null);

      if (
        alreadyEnriched ||
        entry.cost_eur !== null ||
        entry.proceeds_eur !== null ||
        !entry.time_stamp
      ) {
        taxLedgerStore.upsertSyncedTransaction(entry);
      } else {
        const [enriched] = await enrichTaxTransactionsWithEurValues([entry], config);
        taxLedgerStore.upsertSyncedTransaction(enriched);
      }
      synced++;
    }
  }
  return { synced };
}

export async function syncTaxTransactions(
  config: Pick<
    Config,
    "wallet" | "tax" | "hyperSync" | "pricing" | "rpc" | "logsRpc" | "contracts" | "chainId"
  >,
  options: SyncTaxTransactionsOptions = {},
): Promise<SyncTaxTransactionsSummary> {
  const taxLedgerStore = getTaxLedgerStore();
  const wallet = config.wallet;
  const syncedAt = new Date().toISOString();
  const previousSyncState = taxLedgerStore.getSyncState(wallet);
  const fromBlock =
    previousSyncState?.last_block_number != null ? previousSyncState.last_block_number + 1 : 0;

  let synced = 0;
  let latestBlockNumber: number | null = null;

  // ── HyperSync path: txlist + tokentx + tokennfttx ─────────────────────────
  const hyperSyncUrl = config.tax?.hyperSyncUrl ?? config.hyperSync?.url ?? DEFAULT_HYPERSYNC_URL;
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
  const metadataClient = options.viemClient ?? createClient(config);
  const lpViemClient = hasGetBlock(options.viemClient) ? options.viemClient : createClient(config);

  // Fetch both sets first so we can detect grouped zero-native wrappers and
  // merge gas fields onto the first token row for that hash.
  const txs = await fetchTransactionsByAddress(hyperSyncClient, wallet, fromBlock);
  const transfers = await fetchTokenTransfersByAddress(hyperSyncClient, wallet, fromBlock);

  const transfersByHash = new Map<string, HyperSyncTokenTransfer[]>();
  for (const transfer of transfers) {
    const existing = transfersByHash.get(transfer.transactionHash);
    if (existing) {
      existing.push(transfer);
      continue;
    }
    transfersByHash.set(transfer.transactionHash, [transfer]);
  }

  const wrapperGasByHash = new Map<
    string,
    { fee: string; gas_used: string; gas_price: string; firstLogIndex: number }
  >();
  for (const [hash, hashTransfers] of transfersByHash) {
    let firstLogIndex = Number.POSITIVE_INFINITY;
    for (const transfer of hashTransfers) {
      if (transfer.logIndex < firstLogIndex) firstLogIndex = transfer.logIndex;
    }
    if (Number.isFinite(firstLogIndex)) {
      wrapperGasByHash.set(hash, {
        fee: "",
        gas_used: "",
        gas_price: "",
        firstLogIndex,
      });
    }
  }

  // Fetch external transactions
  for (const tx of txs) {
    const mergeTarget = wrapperGasByHash.get(tx.hash);
    const shouldMergeAndSkipWrapper = tx.value === 0n && mergeTarget !== undefined;

    if (shouldMergeAndSkipWrapper) {
      mergeTarget.fee = (tx.gasUsed * tx.gasPrice).toString();
      mergeTarget.gas_used = tx.gasUsed.toString();
      mergeTarget.gas_price = tx.gasPrice.toString();
      if (tx.blockNumber !== null) {
        latestBlockNumber = Math.max(latestBlockNumber ?? tx.blockNumber, tx.blockNumber);
      }
      continue;
    }

    const row = hyperSyncTxToSyncedTaxTransaction(tx, wallet, syncedAt);
    const [enriched] = await enrichTaxTransactionsWithEurValues([row], config);
    taxLedgerStore.upsertSyncedTransaction(enriched);
    synced += 1;
    if (row.block_number !== null) {
      latestBlockNumber = Math.max(latestBlockNumber ?? row.block_number, row.block_number);
    }
  }

  // Fetch token transfers
  for (const transfer of transfers) {
    const baseRow = await hyperSyncTokenTransferToSyncedTaxTransaction(
      transfer,
      wallet,
      metadataClient,
      syncedAt,
    );
    const mergeTarget = wrapperGasByHash.get(transfer.transactionHash);
    const row =
      mergeTarget !== undefined &&
      mergeTarget.firstLogIndex === transfer.logIndex &&
      mergeTarget.fee !== "" &&
      mergeTarget.gas_used !== "" &&
      mergeTarget.gas_price !== ""
        ? {
            ...baseRow,
            fee: mergeTarget.fee,
            gas_used: mergeTarget.gas_used,
            gas_price: mergeTarget.gas_price,
          }
        : baseRow;
    const [enriched] = await enrichTaxTransactionsWithEurValues([row], config);
    taxLedgerStore.upsertSyncedTransaction(enriched);
    synced += 1;
    if (row.block_number !== null) {
      latestBlockNumber = Math.max(latestBlockNumber ?? row.block_number, row.block_number);
    }
  }

  // ── Explorer fallback: txlistinternal only ─────────────────────────────────
  const explorerSynced = await syncInternalTransactions(
    config,
    options,
    wallet,
    fromBlock,
    syncedAt,
  );
  synced += explorerSynced.synced;
  if (explorerSynced.latestBlockNumber !== null) {
    latestBlockNumber = Math.max(
      latestBlockNumber ?? explorerSynced.latestBlockNumber,
      explorerSynced.latestBlockNumber,
    );
  }

  // ── LP flow sync: deposit/withdrawal/fees from LP event data ──────────────
  const lpFlowResult = await syncLpTaxFlows(config, { viemClient: lpViemClient });
  synced += lpFlowResult.synced;

  // ── Hedge tax flows: closed positions from hedge event data ────────────────
  const hedgeFlowResult = await syncHedgeTaxFlows(config, { syncedAt });
  synced += hedgeFlowResult.synced;

  // ── Update sync state watermark ────────────────────────────────────────────
  taxLedgerStore.recordSyncState({
    wallet,
    last_synced_at: syncedAt,
    last_block_number: latestKnownBlockNumber(
      previousSyncState?.last_block_number ?? null,
      latestBlockNumber,
    ),
    source: "hypersync",
  });

  return {
    synced,
    insertedOrUpdated: synced,
    source: "hypersync",
    wallet,
    latestBlockNumber,
    hedgeFlowsSynced: hedgeFlowResult.synced,
  };
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
  viemClient: TokenMetadataClient,
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
  const taxLedgerStore = getTaxLedgerStore();
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
      taxLedgerStore.upsertSyncedTransaction(row);
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
  const taxLedgerStore = getTaxLedgerStore();
  let rows: ReturnType<typeof taxLedgerStore.listTransactionsNeedingEurEnrichment> = [];
  let enriched = 0;
  let skipped = 0;

  try {
    rows = taxLedgerStore.listTransactionsNeedingEurEnrichment();

    for (const row of rows) {
      const asset = row.asset_in ?? row.asset_out;

      if (!asset || !row.timestamp) {
        skipped += 1;
        continue;
      }

      const price = await getHistoricalPrice(config, asset, row.timestamp, "eur");

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

      taxLedgerStore.updateTransactionEurValues(row.id, {
        cost_eur,
        proceeds_eur,
        gain_eur,
      });
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
      const price = await getHistoricalPrice(config, asset, timestamp, "eur");
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

  const body = parseExplorerEnvelope(await response.json());
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

function hasGetBlock(
  client: SyncTaxTransactionsOptions["viemClient"],
): client is TokenMetadataClient & BlockClient {
  return client !== undefined && typeof client.getBlock === "function";
}

function parseExplorerEnvelope(value: unknown): ExplorerEnvelope {
  if (!isExplorerTransaction(value)) return {};

  return {
    status: typeof value.status === "string" ? value.status : undefined,
    message: typeof value.message === "string" ? value.message : undefined,
    result: value.result,
  };
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
