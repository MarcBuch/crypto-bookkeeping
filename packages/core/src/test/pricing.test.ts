import { afterEach, describe, expect, it } from "bun:test";

import {
  getHistoricalEurPrice,
  getHistoricalUsdPrice,
  getUsdPrices,
} from "../services/pricing.js";

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

describe("getHistoricalEurPrice — unknown assets and invalid inputs", () => {
  it("returns null and avoids fetch when symbol is not in coingeckoIds config", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 10 } } });
    const config = { pricing: { coingeckoIds: { OTHER: "other-id" } } };
    const result = await getHistoricalEurPrice(
      config,
      "H_UNKNOWN_ASSET",
      "2024-01-15T00:00:00.000Z",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for empty string symbol", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 10 } } });
    const config = { pricing: { coingeckoIds: { HYPE: "hyperliquid" } } };
    const result = await getHistoricalEurPrice(config, "", "2024-01-15T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch when config has no pricing key", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 10 } } });
    const result = await getHistoricalEurPrice(
      {} as any,
      "H_NO_PRICING_KEY",
      "2024-01-15T00:00:00.000Z",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch when coingeckoIds is empty", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 10 } } });
    const config = { pricing: { coingeckoIds: {} } };
    const result = await getHistoricalEurPrice(config, "H_EMPTY_IDS", "2024-01-15T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for malformed ISO timestamp", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 10 } } });
    const config = { pricing: { coingeckoIds: { H_BAD_TS: "h-bad-ts-id" } } };
    const result = await getHistoricalEurPrice(config, "H_BAD_TS", "not-a-date");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for empty string timestamp", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 10 } } });
    const config = { pricing: { coingeckoIds: { H_EMPTY_TS: "h-empty-ts-id" } } };
    const result = await getHistoricalEurPrice(config, "H_EMPTY_TS", "");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("resolves case-insensitively: config has HYPE_CASE_TEST, call uses hype_case_test", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return {
        ok: true,
        json: async () => ({ market_data: { current_price: { eur: 42.5 } } }),
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { coingeckoIds: { HYPE_CASE_TEST: "hyperliquid-case-test" } } };
    const result = await getHistoricalEurPrice(
      config,
      "hype_case_test",
      "2024-01-15T00:00:00.000Z",
    );
    expect(result).toBe(42.5);
    expect(calls).toHaveLength(1);
  });
});

describe("getHistoricalEurPrice — API failures", () => {
  it("returns null for HTTP 429 without throwing", async () => {
    const calls = mockFetchJson({ error: "rate limited" }, { status: 429 });
    const config = { pricing: { coingeckoIds: { H_429_TOKEN: "h-429-id" } } };
    const result = await getHistoricalEurPrice(config, "H_429_TOKEN", "2024-03-10T12:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null for HTTP 404 without throwing", async () => {
    const calls = mockFetchJson({ error: "not found" }, { status: 404 });
    const config = { pricing: { coingeckoIds: { H_404_TOKEN: "h-404-id" } } };
    const result = await getHistoricalEurPrice(config, "H_404_TOKEN", "2024-03-10T12:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null for HTTP 500 without throwing", async () => {
    const calls = mockFetchJson({ error: "server error" }, { status: 500 });
    const config = { pricing: { coingeckoIds: { H_500_TOKEN: "h-500-id" } } };
    const result = await getHistoricalEurPrice(config, "H_500_TOKEN", "2024-03-10T12:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when market_data exists but current_price key is missing", async () => {
    const calls = mockFetchJson({ market_data: {} });
    const config = { pricing: { coingeckoIds: { H_NO_CP_TOKEN: "h-no-cp-id" } } };
    const result = await getHistoricalEurPrice(config, "H_NO_CP_TOKEN", "2024-03-10T12:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price exists but eur key is missing", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 50 } } });
    const config = { pricing: { coingeckoIds: { H_NO_EUR_TOKEN: "h-no-eur-id" } } };
    const result = await getHistoricalEurPrice(
      config,
      "H_NO_EUR_TOKEN",
      "2024-03-10T12:00:00.000Z",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price.eur is null", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: null } } });
    const config = { pricing: { coingeckoIds: { H_NULL_EUR_TOKEN: "h-null-eur-id" } } };
    const result = await getHistoricalEurPrice(
      config,
      "H_NULL_EUR_TOKEN",
      "2024-03-10T12:00:00.000Z",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price.eur is a string", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: "37.5" } } });
    const config = { pricing: { coingeckoIds: { H_STR_EUR_TOKEN: "h-str-eur-id" } } };
    const result = await getHistoricalEurPrice(
      config,
      "H_STR_EUR_TOKEN",
      "2024-03-10T12:00:00.000Z",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price.eur is Infinity", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: Infinity } } });
    const config = { pricing: { coingeckoIds: { H_INF_EUR_TOKEN: "h-inf-eur-id" } } };
    const result = await getHistoricalEurPrice(
      config,
      "H_INF_EUR_TOKEN",
      "2024-03-10T12:00:00.000Z",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price.eur is negative", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: -5 } } });
    const config = { pricing: { coingeckoIds: { H_NEG_EUR_TOKEN: "h-neg-eur-id" } } };
    const result = await getHistoricalEurPrice(
      config,
      "H_NEG_EUR_TOKEN",
      "2024-03-10T12:00:00.000Z",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when fetch throws a network error", async () => {
    const calls = mockFetchReject(new Error("network down"));
    const config = { pricing: { coingeckoIds: { H_NET_ERR_TOKEN: "h-net-err-id" } } };
    const result = await getHistoricalEurPrice(
      config,
      "H_NET_ERR_TOKEN",
      "2024-03-10T12:00:00.000Z",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("getHistoricalEurPrice — caching", () => {
  it("deduplication — same (asset, date) called twice fetches only once", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 55 } } });
    const config = { pricing: { coingeckoIds: { H_CACHE_DEDUP: "h-cache-dedup-id" } } };
    const ts = "2024-06-01T10:00:00.000Z";

    const r1 = await getHistoricalEurPrice(config, "H_CACHE_DEDUP", ts);
    const r2 = await getHistoricalEurPrice(config, "H_CACHE_DEDUP", ts);

    expect(r1).toBe(55);
    expect(r2).toBe(55);
    expect(calls).toHaveLength(1);
  });

  it("deduplication — different dates for the same asset each trigger their own fetch", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 66 } } });
    const config = { pricing: { coingeckoIds: { H_CACHE_DATES_A: "h-cache-dates-a-id" } } };

    await getHistoricalEurPrice(config, "H_CACHE_DATES_A", "2024-06-01T10:00:00.000Z");
    await getHistoricalEurPrice(config, "H_CACHE_DATES_A", "2024-06-02T10:00:00.000Z");

    expect(calls).toHaveLength(2);
  });

  it("deduplication — different assets on the same date each trigger their own fetch", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 77 } } });
    const config = {
      pricing: {
        coingeckoIds: {
          H_CACHE_ASSETS_A: "h-cache-assets-a-id",
          H_CACHE_ASSETS_B: "h-cache-assets-b-id",
        },
      },
    };
    const ts = "2024-06-03T10:00:00.000Z";

    await getHistoricalEurPrice(config, "H_CACHE_ASSETS_A", ts);
    await getHistoricalEurPrice(config, "H_CACHE_ASSETS_B", ts);

    expect(calls).toHaveLength(2);
  });

  it("positive cache lasts 24 hours (HISTORICAL_PRICE_CACHE_TTL_MS)", async () => {
    const TTL = 24 * 60 * 60 * 1000;
    setNow(0);

    let price = 100;
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return {
        ok: true,
        json: async () => ({ market_data: { current_price: { eur: price } } }),
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { coingeckoIds: { H_CACHE_TTL_POS: "h-cache-ttl-pos-id" } } };
    const ts = "2024-06-04T12:00:00.000Z";

    const r1 = await getHistoricalEurPrice(config, "H_CACHE_TTL_POS", ts);
    expect(r1).toBe(100);
    expect(calls).toHaveLength(1);

    price = 200;
    setNow(TTL - 1);
    const r2 = await getHistoricalEurPrice(config, "H_CACHE_TTL_POS", ts);
    expect(r2).toBe(100);
    expect(calls).toHaveLength(1);

    setNow(TTL);
    const r3 = await getHistoricalEurPrice(config, "H_CACHE_TTL_POS", ts);
    expect(r3).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("negative cache (null response) lasts 5 seconds", async () => {
     setNow(0);
 
     let responseOk = false;
     let responseData: unknown = { error: "not found" };
     const calls: FetchCall[] = [];
     globalThis.fetch = (async (input: RequestInfo | URL) => {
       calls.push({ url: String(input) });
       return {
         ok: responseOk,
         json: async () => responseData,
       } as Response;
     }) as unknown as typeof fetch;
 
     const config = { pricing: { coingeckoIds: { H_CACHE_TTL_NEG: "h-cache-ttl-neg-id" } } };
     const ts = "2024-06-05T12:00:00.000Z";
 
     const r1 = await getHistoricalEurPrice(config, "H_CACHE_TTL_NEG", ts);
     expect(r1).toBeNull();
     expect(calls).toHaveLength(1);
 
     setNow(4999);
     const r2 = await getHistoricalEurPrice(config, "H_CACHE_TTL_NEG", ts);
     expect(r2).toBeNull();
     expect(calls).toHaveLength(1);
 
     responseOk = true;
     responseData = { market_data: { current_price: { eur: 42 } } };
     setNow(5000);
     const r3 = await getHistoricalEurPrice(config, "H_CACHE_TTL_NEG", ts);
     expect(r3).toBe(42);
     expect(calls).toHaveLength(2);
   });
});

describe("getHistoricalUsdPrice — unknown assets and invalid inputs", () => {
  it("returns null and avoids fetch when pricing config is missing", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 10 } } });
    const result = await getHistoricalUsdPrice(
      {} as any,
      "HYPE",
      "2024-01-15T00:00:00.000Z",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch when symbol is not in coingeckoIds config", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 10 } } });
    const config = { pricing: { coingeckoIds: { OTHER: "other-id" } } };
    const result = await getHistoricalUsdPrice(
      config,
      "MISSING_USD_TOKEN",
      "2024-01-15T00:00:00.000Z",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for empty string symbol", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 10 } } });
    const config = { pricing: { coingeckoIds: { HYPE: "hyperliquid" } } };
    const result = await getHistoricalUsdPrice(config, "", "2024-01-15T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for malformed ISO timestamp", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 10 } } });
    const config = { pricing: { coingeckoIds: { HYPE: "hyperliquid" } } };
    const result = await getHistoricalUsdPrice(config, "HYPE", "not-a-date");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for empty string timestamp", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 10 } } });
    const config = { pricing: { coingeckoIds: { HYPE: "hyperliquid" } } };
    const result = await getHistoricalUsdPrice(config, "HYPE", "");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

   it("returns null when current_price exists but usd key is missing", async () => {
     const calls = mockFetchJson({ market_data: { current_price: { eur: 50 } } });
     const config = { pricing: { coingeckoIds: { HYPE: "hyperliquid" } } };
     const result = await getHistoricalUsdPrice(
       config,
       "HYPE",
       "2024-01-15T00:00:00.000Z",
     );
     expect(result).toBeNull();
     expect(calls).toHaveLength(1);
   });
});

describe("getHistoricalUsdPrice — API failures", () => {
  it("returns null for HTTP 429 without throwing", async () => {
    const calls = mockFetchJson({ error: "rate limited" }, { status: 429 });
    const config = { pricing: { coingeckoIds: { USD_429_TOKEN: "usd-429-id" } } };
    const result = await getHistoricalUsdPrice(config, "USD_429_TOKEN", "2024-03-10T12:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null for HTTP 404 without throwing", async () => {
    const calls = mockFetchJson({ error: "not found" }, { status: 404 });
    const config = { pricing: { coingeckoIds: { USD_404_TOKEN: "usd-404-id" } } };
    const result = await getHistoricalUsdPrice(config, "USD_404_TOKEN", "2024-03-10T12:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null for HTTP 500 without throwing", async () => {
    const calls = mockFetchJson({ error: "server error" }, { status: 500 });
    const config = { pricing: { coingeckoIds: { USD_500_TOKEN: "usd-500-id" } } };
    const result = await getHistoricalUsdPrice(config, "USD_500_TOKEN", "2024-03-10T12:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when market_data field is missing", async () => {
    const calls = mockFetchJson({ other_field: { current_price: { usd: 50 } } });
    const config = { pricing: { coingeckoIds: { USD_NO_MD_TOKEN: "usd-no-md-id" } } };
    const result = await getHistoricalUsdPrice(config, "USD_NO_MD_TOKEN", "2024-03-10T12:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price.usd is a string", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: "37.5" } } });
    const config = { pricing: { coingeckoIds: { USD_STR_TOKEN: "usd-str-id" } } };
    const result = await getHistoricalUsdPrice(config, "USD_STR_TOKEN", "2024-03-10T12:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price.usd is Infinity", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: Infinity } } });
    const config = { pricing: { coingeckoIds: { USD_INF_TOKEN: "usd-inf-id" } } };
    const result = await getHistoricalUsdPrice(config, "USD_INF_TOKEN", "2024-03-10T12:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price.usd is negative", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: -5 } } });
    const config = { pricing: { coingeckoIds: { USD_NEG_TOKEN: "usd-neg-id" } } };
    const result = await getHistoricalUsdPrice(config, "USD_NEG_TOKEN", "2024-03-10T12:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when fetch throws a network error", async () => {
    const calls = mockFetchReject(new Error("network down"));
    const config = { pricing: { coingeckoIds: { USD_NET_ERR_TOKEN: "usd-net-err-id" } } };
    const result = await getHistoricalUsdPrice(config, "USD_NET_ERR_TOKEN", "2024-03-10T12:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("getHistoricalUsdPrice — cache behaviour", () => {
  it("cache deduplication — same (symbol, date) called twice fetches only once", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 42.5 } } });
    const config = { pricing: { coingeckoIds: { USD_DEDUP: "usd-dedup-id" } } };
    const ts = "2024-06-01T10:00:00.000Z";

    const r1 = await getHistoricalUsdPrice(config, "USD_DEDUP", ts);
    const r2 = await getHistoricalUsdPrice(config, "USD_DEDUP", ts);

    expect(r1).toBe(42.5);
    expect(r2).toBe(42.5);
    expect(calls).toHaveLength(1);
  });

  it("cache hit after successful fetch — second call returns same price without new fetch", async () => {
    const calls: FetchCall[] = [];
    let responseData: unknown = { market_data: { current_price: { usd: 50 } } };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return {
        ok: true,
        json: async () => responseData,
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { coingeckoIds: { USD_HIT: "usd-hit-id" } } };
    const ts = "2024-06-02T10:00:00.000Z";

    const r1 = await getHistoricalUsdPrice(config, "USD_HIT", ts);
    expect(r1).toBe(50);
    expect(calls).toHaveLength(1);

    // Second call should return cached value without new fetch
    responseData = { market_data: { current_price: { usd: 100 } } };
    const r2 = await getHistoricalUsdPrice(config, "USD_HIT", ts);
    expect(r2).toBe(50);
    expect(calls).toHaveLength(1);
  });

  it("negative cache — after 500 response, second call within 5s returns null without new fetch", async () => {
    setNow(0);
    const calls = mockFetchJson({ error: "server error" }, { status: 500 });

    const config = { pricing: { coingeckoIds: { USD_NEG: "usd-neg-id" } } };
    const ts = "2024-06-03T10:00:00.000Z";

    const r1 = await getHistoricalUsdPrice(config, "USD_NEG", ts);
    expect(r1).toBeNull();
    expect(calls).toHaveLength(1);

    // Within 5 seconds, should use negative cache
    setNow(4999);
    const r2 = await getHistoricalUsdPrice(config, "USD_NEG", ts);
    expect(r2).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("negative TTL expiry — advance Date.now by 6000ms past 5s; next call re-fetches", async () => {
    setNow(0);

    let responseOk = false;
    let responseData: unknown = { error: "not found" };
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return {
        ok: responseOk,
        json: async () => responseData,
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { coingeckoIds: { USD_TTL_NEG: "usd-ttl-neg-id" } } };
    const ts = "2024-06-04T10:00:00.000Z";

    // First call returns null (negative cache)
    const r1 = await getHistoricalUsdPrice(config, "USD_TTL_NEG", ts);
    expect(r1).toBeNull();
    expect(calls).toHaveLength(1);

    // Advance time by 6000ms (past 5s negative TTL)
    setNow(6000);
    responseOk = true;
    responseData = { market_data: { current_price: { usd: 37.5 } } };

    // Should re-fetch because negative cache expired
    const r2 = await getHistoricalUsdPrice(config, "USD_TTL_NEG", ts);
    expect(r2).toBe(37.5);
    expect(calls).toHaveLength(2);
  });

  it("EUR/USD cache isolation — EUR and USD use different cache keys for same symbol+date", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return {
        ok: true,
        json: async () => ({ market_data: { current_price: { eur: 35, usd: 42 } } }),
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { coingeckoIds: { CACHED_ISO: "cached-iso-id" } } };
    const ts = "2024-06-05T10:00:00.000Z";

    // Call EUR version first
    const eurPrice = await getHistoricalEurPrice(config, "CACHED_ISO", ts);
    expect(eurPrice).toBe(35);
    expect(calls).toHaveLength(1);

    // Call USD version — should fetch again because cache keys differ
    const usdPrice = await getHistoricalUsdPrice(config, "CACHED_ISO", ts);
    expect(usdPrice).toBe(42);
    expect(calls).toHaveLength(2);

    // Verify isolation: EUR cache uses "{coinGeckoId}:{date}" and USD uses "usd:{coinGeckoId}:{date}"
    // Second EUR call should use EUR cache (not USD cache)
    const eurPrice2 = await getHistoricalEurPrice(config, "CACHED_ISO", ts);
    expect(eurPrice2).toBe(35);
    expect(calls).toHaveLength(2);

    // Second USD call should use USD cache (not EUR cache)
    const usdPrice2 = await getHistoricalUsdPrice(config, "CACHED_ISO", ts);
    expect(usdPrice2).toBe(42);
    expect(calls).toHaveLength(2);
  });
});
