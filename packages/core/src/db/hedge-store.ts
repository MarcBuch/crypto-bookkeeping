import {
  assignHedgeEvent,
  closeHedgeEvent,
  getAllClosedHedgeEvents,
  getHedgeEvent,
  getHedgeEventByTradeKey,
  getEarliestHedgeSnapshot,
  getHedgeEvents,
  getOpenHedgeEvent,
  insertHedgeEvent,
  insertHedgeSnapshot,
  listHedgeEvents,
  listHedgeSnapshots,
  listUnassignedHedgeEvents,
  type StoredHedgeEvent,
  type StoredHedgeSnapshot,
  upsertHedgeEventByTradeKey,
} from "./store.js";

type HedgeStoreDeps = {
  closeHedgeEvent: typeof closeHedgeEvent;
  getAllClosedHedgeEvents: typeof getAllClosedHedgeEvents;
  getEarliestHedgeSnapshot: typeof getEarliestHedgeSnapshot;
  getHedgeEvents: typeof getHedgeEvents;
  getOpenHedgeEvent: typeof getOpenHedgeEvent;
  insertHedgeEvent: typeof insertHedgeEvent;
  insertHedgeSnapshot: typeof insertHedgeSnapshot;
  listHedgeSnapshots: typeof listHedgeSnapshots;
  assignHedgeEvent?: typeof assignHedgeEvent;
  getHedgeEvent?: typeof getHedgeEvent;
  getHedgeEventByTradeKey?: typeof getHedgeEventByTradeKey;
  listHedgeEvents?: typeof listHedgeEvents;
  listUnassignedHedgeEvents?: typeof listUnassignedHedgeEvents;
  upsertHedgeEventByTradeKey?: typeof upsertHedgeEventByTradeKey;
};

export interface HedgeStore {
  recordSnapshot(snapshot: Omit<StoredHedgeSnapshot, "id" | "snapshot_at">): void;
  listSnapshots(tokenId: string): StoredHedgeSnapshot[];
  findEarliestSnapshot(tokenId: string, coin: string): StoredHedgeSnapshot | null;
  recordEvent(event: Omit<StoredHedgeEvent, "id">): StoredHedgeEvent;
  getEvent(id: number): StoredHedgeEvent | null;
  getEventByTradeKey(tradeKey: string): StoredHedgeEvent | null;
  listAllEvents(): StoredHedgeEvent[];
  listUnassignedEvents(): StoredHedgeEvent[];
  assignEvent(id: number, tokenId: string | null): StoredHedgeEvent | null;
  upsertEventByTradeKey(
    event: Omit<StoredHedgeEvent, "id"> & { trade_key: string },
  ): StoredHedgeEvent;
  closeOpenEvent(params: {
    token_id: string | null;
    coin: string;
    closed_at: string;
    close_px: number;
    realized_pnl: number;
    funding_earned: number | null;
    close_reason: string;
    hl_fill_hash: string;
  }): StoredHedgeEvent | null;
  findOpenEvent(tokenId: string, coin: string): StoredHedgeEvent | null;
  listEvents(tokenId: string): StoredHedgeEvent[];
  findClosedEvent(tokenId: string, coin: string): StoredHedgeEvent | null;
  listClosedEvents(): StoredHedgeEvent[];
}

export function createHedgeStore(deps: HedgeStoreDeps): HedgeStore {
  return {
    recordSnapshot(snapshot) {
      deps.insertHedgeSnapshot(snapshot);
    },

    listSnapshots(tokenId) {
      return deps.listHedgeSnapshots(tokenId);
    },

    findEarliestSnapshot(tokenId, coin) {
      return deps.getEarliestHedgeSnapshot(tokenId, coin);
    },

    recordEvent(event) {
      return deps.insertHedgeEvent(event);
    },

    getEvent(id) {
      return deps.getHedgeEvent?.(id) ?? null;
    },

    getEventByTradeKey(tradeKey) {
      return deps.getHedgeEventByTradeKey?.(tradeKey) ?? null;
    },

    listAllEvents() {
      return deps.listHedgeEvents?.() ?? [];
    },

    listUnassignedEvents() {
      return deps.listUnassignedHedgeEvents?.() ?? [];
    },

    assignEvent(id, tokenId) {
      return deps.assignHedgeEvent?.(id, tokenId) ?? null;
    },

    upsertEventByTradeKey(event) {
      if (!deps.upsertHedgeEventByTradeKey) {
        return deps.insertHedgeEvent(event);
      }
      return deps.upsertHedgeEventByTradeKey(event);
    },

    closeOpenEvent(params) {
      return deps.closeHedgeEvent(params);
    },

    findOpenEvent(tokenId, coin) {
      return deps.getOpenHedgeEvent(tokenId, coin);
    },

    listEvents(tokenId) {
      return deps.getHedgeEvents(tokenId);
    },

    findClosedEvent(tokenId, coin) {
      return (
        deps
          .getHedgeEvents(tokenId)
          .find((event) => event.coin === coin && event.status === "closed") ?? null
      );
    },

    listClosedEvents() {
      return deps.getAllClosedHedgeEvents();
    },
  };
}

export const sqliteHedgeStore = createHedgeStore({
  assignHedgeEvent,
  closeHedgeEvent,
  getAllClosedHedgeEvents,
  getHedgeEvent,
  getHedgeEventByTradeKey,
  getEarliestHedgeSnapshot,
  getHedgeEvents,
  getOpenHedgeEvent,
  insertHedgeEvent,
  insertHedgeSnapshot,
  listHedgeEvents,
  listHedgeSnapshots,
  listUnassignedHedgeEvents,
  upsertHedgeEventByTradeKey,
});
