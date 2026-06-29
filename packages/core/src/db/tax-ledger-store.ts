import {
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
  type ManualTaxTransactionInput,
  type StoredTaxSyncState,
  type StoredTaxTransaction,
  type SyncedTaxTransaction,
  type TaxTransactionLabelFilter,
  type TaxTransactionUpdate,
} from "./store.js";

type TaxLedgerStoreDeps = {
  createManualTaxTransaction: typeof createManualTaxTransaction;
  countTaxTransactions: typeof countTaxTransactions;
  getTaxSyncState: typeof getTaxSyncState;
  getTaxTransaction: typeof getTaxTransaction;
  getTaxTransactionsNeedingEurEnrichment: typeof getTaxTransactionsNeedingEurEnrichment;
  getTaxTransactionsNeedingGermanTaxReview: typeof getTaxTransactionsNeedingGermanTaxReview;
  listGermanTaxableTransactions: typeof listGermanTaxableTransactions;
  listTaxTransactions: typeof listTaxTransactions;
  updateTaxTransaction: typeof updateTaxTransaction;
  updateTaxTransactionEurValues: typeof updateTaxTransactionEurValues;
  upsertSyncedTaxTransaction: typeof upsertSyncedTaxTransaction;
  upsertTaxSyncState: typeof upsertTaxSyncState;
};

export interface TaxLedgerStore {
  upsertSyncedTransaction(transaction: SyncedTaxTransaction): void;
  createManualTransaction(transaction: ManualTaxTransactionInput): StoredTaxTransaction;
  getTransaction(id: string): StoredTaxTransaction | null;
  listTransactions(
    limit?: number,
    offset?: number,
    label?: TaxTransactionLabelFilter,
  ): StoredTaxTransaction[];
  countTransactions(label?: TaxTransactionLabelFilter): number;
  listGermanTaxableTransactions(limit?: number, offset?: number): StoredTaxTransaction[];
  listTransactionsNeedingGermanTaxReview(limit?: number, offset?: number): StoredTaxTransaction[];
  updateTransaction(id: string, update: TaxTransactionUpdate): StoredTaxTransaction | null;
  recordSyncState(syncState: StoredTaxSyncState): void;
  getSyncState(wallet: string): StoredTaxSyncState | null;
  listTransactionsNeedingEurEnrichment(): ReturnType<typeof getTaxTransactionsNeedingEurEnrichment>;
  updateTransactionEurValues(
    id: string,
    values: { cost_eur: string | null; proceeds_eur: string | null; gain_eur: string | null },
  ): void;
}

export function createTaxLedgerStore(deps: TaxLedgerStoreDeps): TaxLedgerStore {
  return {
    upsertSyncedTransaction(transaction) {
      deps.upsertSyncedTaxTransaction(transaction);
    },

    createManualTransaction(transaction) {
      return deps.createManualTaxTransaction(transaction);
    },

    getTransaction(id) {
      return deps.getTaxTransaction(id);
    },

    listTransactions(limit, offset, label) {
      return deps.listTaxTransactions(limit, offset, label);
    },

    countTransactions(label) {
      return deps.countTaxTransactions(label);
    },

    listGermanTaxableTransactions(limit, offset) {
      return deps.listGermanTaxableTransactions(limit, offset);
    },

    listTransactionsNeedingGermanTaxReview(limit, offset) {
      return deps.getTaxTransactionsNeedingGermanTaxReview(limit, offset);
    },

    updateTransaction(id, update) {
      return deps.updateTaxTransaction(id, update);
    },

    recordSyncState(syncState) {
      deps.upsertTaxSyncState(syncState);
    },

    getSyncState(wallet) {
      return deps.getTaxSyncState(wallet);
    },

    listTransactionsNeedingEurEnrichment() {
      return deps.getTaxTransactionsNeedingEurEnrichment();
    },

    updateTransactionEurValues(id, values) {
      deps.updateTaxTransactionEurValues(id, values);
    },
  };
}

export const sqliteTaxLedgerStore = createTaxLedgerStore({
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
