import { afterEach, describe, expect, it } from "bun:test";
import { getUsdPrices } from "../services/pricing.js";

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;

type FetchCall = {
  url: string;
};

function mockFetchJson(data: unknown, init: ResponseInit = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push({ url: String(input) });
    const status = init.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      json: async () => data,
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function mockFetchReject(error = new Error("network down")): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push({ url: String(input) });
    throw error;
  }) as unknown as typeof fetch;
  return calls;
}

function setNow(now: number): void {
  Date.now = () => now;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
});

describe("getUsdPrices", () => {
  it("returns null and avoids fetch when pricing config is missing", async () => {
    const calls = mockFetchJson({ unused: { usd: 1 } });

    await expect(getUsdPrices({}, ["HYPE"])).resolves.toEqual({ HYPE: null });
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch when no token mapping exists", async () => {
    const calls = mockFetchJson({ unused: { usd: 1 } });

    await expect(
      getUsdPrices({ pricing: { coingeckoIds: { OTHER: "other-id" } } }, ["HYPE"]),
    ).resolves.toEqual({ HYPE: null });
    expect(calls).toHaveLength(0);
  });

  it("fetches CoinGecko simple prices and returns USD keyed by token identity", async () => {
    const calls = mockFetchJson({ hyperliquid: { usd: 37.42 } });

    await expect(
      getUsdPrices({ pricing: { coingeckoIds: { HYPE: "hyperliquid" } } }, [
        { symbol: "HYPE", address: "0xABCDEF" },
      ]),
    ).resolves.toEqual({ "0xabcdef": 37.42 });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://api.coingecko.com/api/v3/simple/price");
    expect(url.searchParams.get("ids")).toBe("hyperliquid");
    expect(url.searchParams.get("vs_currencies")).toBe("usd");
  });

  it("returns null for malformed responses and missing token entries", async () => {
    const malformedCalls = mockFetchJson(["not", "an", "object"]);

    await expect(
      getUsdPrices({ pricing: { coingeckoIds: { BAD_ARRAY_TOKEN: "bad-array-response" } } }, [
        "BAD_ARRAY_TOKEN",
      ]),
    ).resolves.toEqual({ BAD_ARRAY_TOKEN: null });
    expect(malformedCalls).toHaveLength(1);

    const missingCalls = mockFetchJson({ other: { usd: 1 } });
    await expect(
      getUsdPrices({ pricing: { coingeckoIds: { MISSING_TOKEN: "missing-token-entry" } } }, [
        "MISSING_TOKEN",
      ]),
    ).resolves.toEqual({ MISSING_TOKEN: null });
    expect(missingCalls).toHaveLength(1);
  });

  it("returns null for null, non-numeric, non-finite, and negative USD values", async () => {
    const calls = mockFetchJson({
      null_price: { usd: null },
      string_price: { usd: "1.23" },
      infinite_price: { usd: Infinity },
      negative_price: { usd: -1 },
    });

    await expect(
      getUsdPrices(
        {
          pricing: {
            coingeckoIds: {
              NULL_PRICE: "null_price",
              STRING_PRICE: "string_price",
              INFINITE_PRICE: "infinite_price",
              NEGATIVE_PRICE: "negative_price",
            },
          },
        },
        ["NULL_PRICE", "STRING_PRICE", "INFINITE_PRICE", "NEGATIVE_PRICE"],
      ),
    ).resolves.toEqual({
      NULL_PRICE: null,
      STRING_PRICE: null,
      INFINITE_PRICE: null,
      NEGATIVE_PRICE: null,
    });
    expect(calls).toHaveLength(1);
  });

  it("returns null without throwing for non-2xx responses", async () => {
    const calls = mockFetchJson({ error: "rate limited" }, { status: 429 });

    await expect(
      getUsdPrices({ pricing: { coingeckoIds: { NON_2XX_TOKEN: "non-2xx-token" } } }, [
        "NON_2XX_TOKEN",
      ]),
    ).resolves.toEqual({ NON_2XX_TOKEN: null });
    expect(calls).toHaveLength(1);
  });

  it("returns null without throwing when fetch rejects", async () => {
    const calls = mockFetchReject();

    await expect(
      getUsdPrices(
        { pricing: { coingeckoIds: { REJECTED_FETCH_TOKEN: "rejected-fetch-token" } } },
        ["REJECTED_FETCH_TOKEN"],
      ),
    ).resolves.toEqual({ REJECTED_FETCH_TOKEN: null });
    expect(calls).toHaveLength(1);
  });

  it("avoids fetch for an empty token list", async () => {
    const calls = mockFetchJson({ unused: { usd: 1 } });

    await expect(
      getUsdPrices({ pricing: { coingeckoIds: { HYPE: "hyperliquid" } } }, []),
    ).resolves.toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("uses the positive cache within 60 seconds and refetches after expiry", async () => {
    setNow(1_000);
    let price = 10;
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return {
        ok: true,
        json: async () => ({ positive_cache_token: { usd: price } }),
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { coingeckoIds: { POSITIVE_CACHE_TOKEN: "positive_cache_token" } } };

    await expect(getUsdPrices(config, ["POSITIVE_CACHE_TOKEN"])).resolves.toEqual({
      POSITIVE_CACHE_TOKEN: 10,
    });
    price = 20;
    setNow(60_999);
    await expect(getUsdPrices(config, ["POSITIVE_CACHE_TOKEN"])).resolves.toEqual({
      POSITIVE_CACHE_TOKEN: 10,
    });
    setNow(61_000);
    await expect(getUsdPrices(config, ["POSITIVE_CACHE_TOKEN"])).resolves.toEqual({
      POSITIVE_CACHE_TOKEN: 20,
    });

    expect(calls).toHaveLength(2);
  });

  it("uses the negative cache within 5 seconds and refetches after expiry", async () => {
    setNow(2_000);
    let data: unknown = { negative_cache_token: { usd: null } };
    const calls = mockFetchJson(data);

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return {
        ok: true,
        json: async () => data,
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { coingeckoIds: { NEGATIVE_CACHE_TOKEN: "negative_cache_token" } } };

    await expect(getUsdPrices(config, ["NEGATIVE_CACHE_TOKEN"])).resolves.toEqual({
      NEGATIVE_CACHE_TOKEN: null,
    });
    data = { negative_cache_token: { usd: 30 } };
    setNow(6_999);
    await expect(getUsdPrices(config, ["NEGATIVE_CACHE_TOKEN"])).resolves.toEqual({
      NEGATIVE_CACHE_TOKEN: null,
    });
    setNow(7_000);
    await expect(getUsdPrices(config, ["NEGATIVE_CACHE_TOKEN"])).resolves.toEqual({
      NEGATIVE_CACHE_TOKEN: 30,
    });

    expect(calls).toHaveLength(2);
  });

  it("skips invalid token objects without creating an empty-string key", async () => {
    const calls = mockFetchJson({ empty_token: { usd: 1 } });

    await expect(
      getUsdPrices({ pricing: { coingeckoIds: { "": "empty_token" } } }, [
        {},
        { symbol: "", address: "" },
      ]),
    ).resolves.toEqual({});
    expect(calls).toHaveLength(0);
  });
});
