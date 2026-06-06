import { describe, it, expect } from "bun:test";

import { getDb } from "../db/schema.js";
import { upsertTokenMetadata, getTokenMetadata, type StoredTokenMetadata } from "../db/store.js";
import { useTestDb } from "./helpers/db.js";

function makeTokenMetadata(overrides: Partial<StoredTokenMetadata> = {}): StoredTokenMetadata {
  return {
    contract_address: "0xabc123",
    symbol: "HYPE",
    name: "HyperToken",
    decimals: 18,
    fetched_at: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("getTokenMetadata — cache miss", () => {
  useTestDb();

  it("returns null for an unknown contract address", () => {
    const result = getTokenMetadata("0xdeadbeef");
    expect(result).toBeNull();
  });

  it("returns null for an address that was never inserted", () => {
    // Insert a different address first
    upsertTokenMetadata(makeTokenMetadata({ contract_address: "0xaaa" }));
    const result = getTokenMetadata("0xbbb");
    expect(result).toBeNull();
  });
});

describe("upsertTokenMetadata + getTokenMetadata — basic CRUD", () => {
  useTestDb();

  it("inserts a new row and retrieves it with all fields intact", () => {
    const meta = makeTokenMetadata();
    upsertTokenMetadata(meta);
    const result = getTokenMetadata(meta.contract_address);
    expect(result).not.toBeNull();
    expect(result!.contract_address).toBe(meta.contract_address.toLowerCase());
    expect(result!.symbol).toBe("HYPE");
    expect(result!.name).toBe("HyperToken");
    expect(result!.decimals).toBe(18);
    expect(result!.fetched_at).toBe("2026-06-01T10:00:00.000Z");
  });

  it("stores a row with null symbol, name, and decimals (partial metadata)", () => {
    const meta = makeTokenMetadata({ symbol: null, name: null, decimals: null });
    upsertTokenMetadata(meta);
    const result = getTokenMetadata(meta.contract_address);
    expect(result).not.toBeNull();
    expect(result!.symbol).toBeNull();
    expect(result!.name).toBeNull();
    expect(result!.decimals).toBeNull();
  });

  it("stores and retrieves fetched_at as-is", () => {
    const ts = "2026-01-15T08:30:00.000Z";
    upsertTokenMetadata(makeTokenMetadata({ fetched_at: ts }));
    const result = getTokenMetadata("0xabc123");
    expect(result!.fetched_at).toBe(ts);
  });

  it("stores contract_address as lowercase regardless of input case", () => {
    upsertTokenMetadata(makeTokenMetadata({ contract_address: "0xABC123UPPER" }));
    const result = getTokenMetadata("0xabc123upper");
    expect(result).not.toBeNull();
    expect(result!.contract_address).toBe("0xabc123upper");
  });

  it("getTokenMetadata lookup is case-insensitive (mixed-case address finds lowercase-stored row)", () => {
    upsertTokenMetadata(makeTokenMetadata({ contract_address: "0xMixedCase" }));
    // Lookup with different casing
    const result = getTokenMetadata("0xMIXEDCASE");
    expect(result).not.toBeNull();
    expect(result!.contract_address).toBe("0xmixedcase");
  });
});

describe("upsertTokenMetadata — update behavior", () => {
  useTestDb();

  it("upserting the same contract address updates all fields (not duplicates)", () => {
    const address = "0xcontract";
    upsertTokenMetadata(makeTokenMetadata({ contract_address: address, symbol: "OLD" }));
    upsertTokenMetadata(
      makeTokenMetadata({ contract_address: address, symbol: "NEW", decimals: 6 }),
    );

    const db = getDb();
    const rows = db
      .query("SELECT * FROM token_metadata WHERE contract_address = ?")
      .all(address.toLowerCase());
    expect(rows).toHaveLength(1);
  });

  it("after upsert, only one row exists for the contract address", () => {
    const address = "0xsingle";
    for (let i = 0; i < 3; i++) {
      upsertTokenMetadata(
        makeTokenMetadata({
          contract_address: address,
          fetched_at: `2026-06-0${i + 1}T00:00:00.000Z`,
        }),
      );
    }
    const db = getDb();
    const rows = db
      .query("SELECT * FROM token_metadata WHERE contract_address = ?")
      .all(address.toLowerCase());
    expect(rows).toHaveLength(1);
  });

  it("updating with new symbol and decimals replaces old values", () => {
    const address = "0xupdate";
    upsertTokenMetadata(
      makeTokenMetadata({ contract_address: address, symbol: "FIRST", decimals: 18 }),
    );
    upsertTokenMetadata(
      makeTokenMetadata({ contract_address: address, symbol: "SECOND", decimals: 6 }),
    );
    const result = getTokenMetadata(address);
    expect(result!.symbol).toBe("SECOND");
    expect(result!.decimals).toBe(6);
  });

  it("updating with symbol = null replaces a previously non-null symbol with null", () => {
    const address = "0xnullsymbol";
    upsertTokenMetadata(makeTokenMetadata({ contract_address: address, symbol: "NOTNULL" }));
    upsertTokenMetadata(makeTokenMetadata({ contract_address: address, symbol: null }));
    const result = getTokenMetadata(address);
    expect(result!.symbol).toBeNull();
  });
});

describe("schema migration — token_metadata table exists in fresh DB", () => {
  useTestDb();

  it("the token_metadata table exists after calling getDb() on a fresh DB", () => {
    const db = getDb();
    const rows = db.query("PRAGMA table_info(token_metadata)").all() as Array<{
      name: string;
      pk: number;
    }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("the table has the correct columns", () => {
    const db = getDb();
    const rows = db.query("PRAGMA table_info(token_metadata)").all() as Array<{
      name: string;
      pk: number;
    }>;
    const columnNames = rows.map((r) => r.name);
    expect(columnNames).toContain("contract_address");
    expect(columnNames).toContain("symbol");
    expect(columnNames).toContain("name");
    expect(columnNames).toContain("decimals");
    expect(columnNames).toContain("fetched_at");
  });

  it("contract_address is the PRIMARY KEY", () => {
    const db = getDb();
    const rows = db.query("PRAGMA table_info(token_metadata)").all() as Array<{
      name: string;
      pk: number;
    }>;
    const pkCol = rows.find((r) => r.name === "contract_address");
    expect(pkCol).toBeDefined();
    expect(pkCol!.pk).toBe(1);
  });
});
