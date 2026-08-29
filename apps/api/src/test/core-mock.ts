import { mock } from "bun:test";

// Keep this aligned with every runtime @lp-tracker/core import in the API server graph.
export function createCoreMock(): Record<string, unknown> {
  return {
    loadConfig: () => {
      throw new Error("loadConfig was not configured for this test");
    },
    resolveConfigPath: () => "/test/config.json",
    getPositionsView: async () => [],
    listCachedPositionViews: () => [],
    listCachedPnLViews: () => [],
    getPositionsCacheSyncedAt: () => null,
    syncLpData: async () => ({ synced: 0 }),
    syncSinglePosition: async () => ({ tokenId: "42", syncedAt: new Date().toISOString() }),
    getPnLView: async () => [],
    getILView: async () => [],
    getHistoryView: async () => [],
    getHedgeView: async () => null,
    getHedgeEvents: async () => [],
    listHedgeEvents: () => [],
    assignHedgeEvent: () => null,
    listTaxTransactions: () => [],
    countTaxTransactions: () => 0,
    syncTaxTransactions: async () => ({}),
    updateTaxTransaction: () => null,
    createManualTaxTransaction: () => null,
    enrichTaxTransactionsEurValues: async () => ({ enriched: 0, skipped: 0 }),
    getPosition: () => null,
    createClient: () => ({ getBlock: async () => ({ timestamp: 0n }) }),
    updateCachedPnLView: () => undefined,
    NotFoundError: class NotFoundError extends Error {},
    RpcError: class RpcError extends Error {},
    ValidationError: class ValidationError extends Error {},
  };
}

export async function installCoreMock(overrides: Record<string, unknown>): Promise<void> {
  await mock.module("@lp-tracker/core", () => ({ ...createCoreMock(), ...overrides }));
}
