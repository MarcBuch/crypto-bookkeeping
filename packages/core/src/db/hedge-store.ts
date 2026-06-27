import {
  closeHedgeEvent,
  getAllClosedHedgeEvents,
  getEarliestHedgeSnapshot,
  getHedgeEvents,
  getOpenHedgeEvent,
  insertHedgeEvent,
  insertHedgeSnapshot,
  listHedgeSnapshots,
  type StoredHedgeEvent,
  type StoredHedgeSnapshot,
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
};

export interface HedgeStore {
  recordSnapshot(snapshot: Omit<StoredHedgeSnapshot, "id" | "snapshot_at">): void;
  listSnapshots(tokenId: string): StoredHedgeSnapshot[];
  findEarliestSnapshot(tokenId: string, coin: string): StoredHedgeSnapshot | null;
  recordEvent(event: Omit<StoredHedgeEvent, "id">): StoredHedgeEvent;
  closeOpenEvent(params: {
    token_id: string;
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
  closeHedgeEvent,
  getAllClosedHedgeEvents,
  getEarliestHedgeSnapshot,
  getHedgeEvents,
  getOpenHedgeEvent,
  insertHedgeEvent,
  insertHedgeSnapshot,
  listHedgeSnapshots,
});
