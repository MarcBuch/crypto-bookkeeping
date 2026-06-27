// Chain
export * from "./chain/abis.js";
export * from "./chain/client.js";
export * from "./chain/events.js";
export * from "./chain/pools.js";
export * from "./chain/rpc.js";
// chain/positions — export everything except getAllPositions to avoid clash with db/store
export {
  getPositionCount,
  getTokenId,
  getPositionData,
  getAllPositions as getAllOnChainPositions,
} from "./chain/positions.js";
export type { PositionData } from "./chain/positions.js";

// Config
export * from "./config.js";

// DB — export everything except getAllPositions (renamed to avoid clash)
export {
  upsertPosition,
  getPosition,
  insertSnapshot,
  getSnapshots,
  getLatestSnapshot,
  getAllLatestSnapshots,
  insertHedgeSnapshot,
  listHedgeSnapshots,
  getEarliestHedgeSnapshot,
  insertHedgeEvent,
  closeHedgeEvent,
  getOpenHedgeEvent,
  getHedgeEvents,
  getAllClosedHedgeEvents,
  upsertSyncedTaxTransaction,
  createManualTaxTransaction,
  getTaxTransaction,
  listTaxTransactions,
  listGermanTaxableTransactions,
  getTaxTransactionsNeedingGermanTaxReview,
  updateTaxTransaction,
  upsertTaxSyncState,
  getTaxSyncState,
  getTaxTransactionsNeedingEurEnrichment,
  updateTaxTransactionEurValues,
  listCachedPositionViews,
  listCachedPnLViews,
  getPositionsCacheSyncedAt,
  replaceCachedPositionViews,
  replaceCachedPnLViews,
  replaceLpCaches,
  getLpSyncState,
  upsertLpSyncState,
  upsertPositionViewCache,
  upsertPnLViewCache,
} from "./db/store.js";
export { getAllPositions as getAllStoredPositions } from "./db/store.js";
export type {
  StoredPosition,
  StoredSnapshot,
  StoredHedgeSnapshot,
  StoredHedgeEvent,
  TaxTransactionLabel,
  TaxTransactionLabelFilter,
  StoredTaxTransaction,
  SyncedTaxTransaction,
  ManualTaxTransactionInput,
  TaxTransactionUpdate,
  StoredTaxSyncState,
  StoredLpSyncState,
} from "./db/store.js";
export * from "./db/hedge-store.js";
export * from "./db/position-store.js";
export * from "./db/tax-ledger-store.js";
export * from "./db/schema.js";

// Display
export * from "./display/table.js";

// Math
export * from "./math/divergence-loss.js";

// Services
export * from "./services/errors.js";
export * from "./services/positions.js";
export * from "./services/lp-economics.js";
export * from "./services/pnl.js";
export * from "./services/il.js";
export * from "./services/snapshot.js";
export * from "./services/position-lifecycle.js";
export * from "./services/history.js";
export * from "./services/pricing.js";
export * from "./services/hedge.js";
export {
  syncTaxTransactions,
  enrichTaxTransactionsEurValues,
  buildHedgeTaxEntries,
  syncHedgeTaxFlows,
} from "./services/tax-transactions.js";
export type {
  SyncTaxTransactionsOptions,
  SyncTaxTransactionsSummary,
} from "./services/tax-transactions.js";
