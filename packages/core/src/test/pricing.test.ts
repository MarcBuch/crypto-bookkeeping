import { afterEach, describe, expect, it } from "bun:test";

import { getHistoricalPrice, getUsdPrices } from "../services/pricing.js";
import { getRequestUrl, jsonResponse, setFetchMock } from "./helpers/http.js";

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;

type FetchCall = {
  url: string;
};

function mockFetchJson(data: unknown, init: ResponseInit = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  setFetchMock(async (input) => {
    calls.push({ url: getRequestUrl(input) });
    return jsonResponse(data, init);
  });
  return calls;
}

function mockFetchReject(error = new Error("network down")): FetchCall[] {
  const calls: FetchCall[] = [];
  setFetchMock(async (input) => {
    calls.push({ url: getRequestUrl(input) });
    throw error;
  });
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

    const result = await getUsdPrices({}, ["HYPE"]);
    expect(result).toEqual({ HYPE: null });
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch when no token mapping exists", async () => {
    const calls = mockFetchJson({ unused: { usd: 1 } });

    const result = await getUsdPrices({ pricing: { coingeckoIds: { OTHER: "other-id" } } }, [
      "HYPE",
    ]);
    expect(result).toEqual({ HYPE: null });
    expect(calls).toHaveLength(0);
  });

  it("fetches CoinGecko simple prices and returns USD keyed by token identity", async () => {
    const calls = mockFetchJson({ hyperliquid: { usd: 37.42 } });

    const result = await getUsdPrices({ pricing: { coingeckoIds: { HYPE: "hyperliquid" } } }, [
      { symbol: "HYPE", address: "0xABCDEF" },
    ]);
    expect(result).toEqual({ "0xabcdef": 37.42 });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://api.coingecko.com/api/v3/simple/price");
    expect(url.searchParams.get("ids")).toBe("hyperliquid");
    expect(url.searchParams.get("vs_currencies")).toBe("usd");
  });

  it("returns null for malformed responses and missing token entries", async () => {
    const malformedCalls = mockFetchJson(["not", "an", "object"]);

    let result = await getUsdPrices(
      { pricing: { coingeckoIds: { BAD_ARRAY_TOKEN: "bad-array-response" } } },
      ["BAD_ARRAY_TOKEN"],
    );
    expect(result).toEqual({ BAD_ARRAY_TOKEN: null });
    expect(malformedCalls).toHaveLength(1);

    const missingCalls = mockFetchJson({ other: { usd: 1 } });
    result = await getUsdPrices(
      { pricing: { coingeckoIds: { MISSING_TOKEN: "missing-token-entry" } } },
      ["MISSING_TOKEN"],
    );
    expect(result).toEqual({ MISSING_TOKEN: null });
    expect(missingCalls).toHaveLength(1);
  });

  it("returns null for null, non-numeric, non-finite, and negative USD values", async () => {
    const calls = mockFetchJson({
      null_price: { usd: null },
      string_price: { usd: "1.23" },
      infinite_price: { usd: Infinity },
      negative_price: { usd: -1 },
    });

    const result = await getUsdPrices(
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
    );
    expect(result).toEqual({
      NULL_PRICE: null,
      STRING_PRICE: null,
      INFINITE_PRICE: null,
      NEGATIVE_PRICE: null,
    });
    expect(calls).toHaveLength(1);
  });

  it("returns null without throwing for non-2xx responses", async () => {
    const calls = mockFetchJson({ error: "rate limited" }, { status: 429 });

    const result = await getUsdPrices(
      { pricing: { coingeckoIds: { NON_2XX_TOKEN: "non-2xx-token" } } },
      ["NON_2XX_TOKEN"],
    );
    expect(result).toEqual({ NON_2XX_TOKEN: null });
    expect(calls).toHaveLength(1);
  });

  it("returns null without throwing when fetch rejects", async () => {
    const calls = mockFetchReject();

    const result = await getUsdPrices(
      { pricing: { coingeckoIds: { REJECTED_FETCH_TOKEN: "rejected-fetch-token" } } },
      ["REJECTED_FETCH_TOKEN"],
    );
    expect(result).toEqual({ REJECTED_FETCH_TOKEN: null });
    expect(calls).toHaveLength(1);
  });

  it("avoids fetch for an empty token list", async () => {
    const calls = mockFetchJson({ unused: { usd: 1 } });

    const result = await getUsdPrices({ pricing: { coingeckoIds: { HYPE: "hyperliquid" } } }, []);
    expect(result).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("uses the positive cache within 60 seconds and refetches after expiry", async () => {
    setNow(1_000);
    let price = 10;
    const calls: FetchCall[] = [];
    setFetchMock(async (input) => {
      calls.push({ url: getRequestUrl(input) });
      return jsonResponse({ positive_cache_token: { usd: price } });
    });

    const config = { pricing: { coingeckoIds: { POSITIVE_CACHE_TOKEN: "positive_cache_token" } } };

    let result = await getUsdPrices(config, ["POSITIVE_CACHE_TOKEN"]);
    expect(result).toEqual({
      POSITIVE_CACHE_TOKEN: 10,
    });
    price = 20;
    setNow(60_999);
    result = await getUsdPrices(config, ["POSITIVE_CACHE_TOKEN"]);
    expect(result).toEqual({
      POSITIVE_CACHE_TOKEN: 10,
    });
    setNow(61_000);
    result = await getUsdPrices(config, ["POSITIVE_CACHE_TOKEN"]);
    expect(result).toEqual({
      POSITIVE_CACHE_TOKEN: 20,
    });

    expect(calls).toHaveLength(2);
  });

  it("uses the negative cache within 5 seconds and refetches after expiry", async () => {
    setNow(2_000);
    let data: unknown = { negative_cache_token: { usd: null } };
    const calls = mockFetchJson(data);

    setFetchMock(async (input) => {
      calls.push({ url: getRequestUrl(input) });
      return jsonResponse(data);
    });

    const config = { pricing: { coingeckoIds: { NEGATIVE_CACHE_TOKEN: "negative_cache_token" } } };

    let result = await getUsdPrices(config, ["NEGATIVE_CACHE_TOKEN"]);
    expect(result).toEqual({
      NEGATIVE_CACHE_TOKEN: null,
    });
    data = { negative_cache_token: { usd: 30 } };
    setNow(6_999);
    result = await getUsdPrices(config, ["NEGATIVE_CACHE_TOKEN"]);
    expect(result).toEqual({
      NEGATIVE_CACHE_TOKEN: null,
    });
    setNow(7_000);
    result = await getUsdPrices(config, ["NEGATIVE_CACHE_TOKEN"]);
    expect(result).toEqual({
      NEGATIVE_CACHE_TOKEN: 30,
    });

    expect(calls).toHaveLength(2);
  });

  it("skips invalid token objects without creating an empty-string key", async () => {
    const calls = mockFetchJson({ empty_token: { usd: 1 } });

    const result = await getUsdPrices({ pricing: { coingeckoIds: { "": "empty_token" } } }, [
      {},
      { symbol: "" },
    ]);
    expect(result).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe("getHistoricalPrice — EUR — unknown assets and invalid inputs", () => {
  it("returns null and avoids fetch when symbol is not in coingeckoIds config", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 10 } } });
    const config = { pricing: { coingeckoIds: { OTHER: "other-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_UNKNOWN_ASSET",
      "2024-01-15T00:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for empty string symbol", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 10 } } });
    const config = { pricing: { coingeckoIds: { HYPE: "hyperliquid" } } };
    const result = await getHistoricalPrice(config, "", "2024-01-15T00:00:00.000Z", "eur");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch when config has no pricing key", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 10 } } });
    const result = await getHistoricalPrice(
      {},
      "H_NO_PRICING_KEY",
      "2024-01-15T00:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch when coingeckoIds is empty", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 10 } } });
    const config = { pricing: { coingeckoIds: {} } };
    const result = await getHistoricalPrice(
      config,
      "H_EMPTY_IDS",
      "2024-01-15T00:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for malformed ISO timestamp", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 10 } } });
    const config = { pricing: { coingeckoIds: { H_BAD_TS: "h-bad-ts-id" } } };
    const result = await getHistoricalPrice(config, "H_BAD_TS", "not-a-date", "eur");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for empty string timestamp", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 10 } } });
    const config = { pricing: { coingeckoIds: { H_EMPTY_TS: "h-empty-ts-id" } } };
    const result = await getHistoricalPrice(config, "H_EMPTY_TS", "", "eur");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("resolves case-insensitively: config has HYPE_CASE_TEST, call uses hype_case_test", async () => {
    const calls: FetchCall[] = [];
    setFetchMock(async (input) => {
      calls.push({ url: getRequestUrl(input) });
      return jsonResponse({ market_data: { current_price: { eur: 42.5 } } });
    });

    const config = { pricing: { coingeckoIds: { HYPE_CASE_TEST: "hyperliquid-case-test" } } };
    const result = await getHistoricalPrice(
      config,
      "hype_case_test",
      "2024-01-15T00:00:00.000Z",
      "eur",
    );
    expect(result).toBe(42.5);
    expect(calls).toHaveLength(1);
  });
});

describe("getHistoricalPrice — EUR — API failures", () => {
  it("returns null for HTTP 429 without throwing", async () => {
    const calls = mockFetchJson({ error: "rate limited" }, { status: 429 });
    const config = { pricing: { coingeckoIds: { H_429_TOKEN: "h-429-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_429_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null for HTTP 404 without throwing", async () => {
    const calls = mockFetchJson({ error: "not found" }, { status: 404 });
    const config = { pricing: { coingeckoIds: { H_404_TOKEN: "h-404-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_404_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null for HTTP 500 without throwing", async () => {
    const calls = mockFetchJson({ error: "server error" }, { status: 500 });
    const config = { pricing: { coingeckoIds: { H_500_TOKEN: "h-500-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_500_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when market_data exists but current_price key is missing", async () => {
    const calls = mockFetchJson({ market_data: {} });
    const config = { pricing: { coingeckoIds: { H_NO_CP_TOKEN: "h-no-cp-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_NO_CP_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price exists but eur key is missing", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 50 } } });
    const config = { pricing: { coingeckoIds: { H_NO_EUR_TOKEN: "h-no-eur-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_NO_EUR_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price.eur is null", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: null } } });
    const config = { pricing: { coingeckoIds: { H_NULL_EUR_TOKEN: "h-null-eur-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_NULL_EUR_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price.eur is a string", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: "37.5" } } });
    const config = { pricing: { coingeckoIds: { H_STR_EUR_TOKEN: "h-str-eur-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_STR_EUR_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price.eur is Infinity", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: Infinity } } });
    const config = { pricing: { coingeckoIds: { H_INF_EUR_TOKEN: "h-inf-eur-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_INF_EUR_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price.eur is negative", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: -5 } } });
    const config = { pricing: { coingeckoIds: { H_NEG_EUR_TOKEN: "h-neg-eur-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_NEG_EUR_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when fetch throws a network error", async () => {
    const calls = mockFetchReject(new Error("network down"));
    const config = { pricing: { coingeckoIds: { H_NET_ERR_TOKEN: "h-net-err-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_NET_ERR_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("getHistoricalPrice — EUR — caching", () => {
  it("deduplication — same (asset, date) called twice fetches only once", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 55 } } });
    const config = { pricing: { coingeckoIds: { H_CACHE_DEDUP: "h-cache-dedup-id" } } };
    const ts = "2024-06-01T10:00:00.000Z";

    const r1 = await getHistoricalPrice(config, "H_CACHE_DEDUP", ts, "eur");
    const r2 = await getHistoricalPrice(config, "H_CACHE_DEDUP", ts, "eur");

    expect(r1).toBe(55);
    expect(r2).toBe(55);
    expect(calls).toHaveLength(1);
  });

  it("deduplication — different dates for the same asset each trigger their own fetch", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 66 } } });
    const config = { pricing: { coingeckoIds: { H_CACHE_DATES_A: "h-cache-dates-a-id" } } };

    await getHistoricalPrice(config, "H_CACHE_DATES_A", "2024-06-01T10:00:00.000Z", "eur");
    await getHistoricalPrice(config, "H_CACHE_DATES_A", "2024-06-02T10:00:00.000Z", "eur");

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

    await getHistoricalPrice(config, "H_CACHE_ASSETS_A", ts, "eur");
    await getHistoricalPrice(config, "H_CACHE_ASSETS_B", ts, "eur");

    expect(calls).toHaveLength(2);
  });

  it("positive cache lasts 24 hours (HISTORICAL_PRICE_CACHE_TTL_MS)", async () => {
    const TTL = 24 * 60 * 60 * 1000;
    setNow(0);

    let price = 100;
    const calls: FetchCall[] = [];
    setFetchMock(async (input) => {
      calls.push({ url: getRequestUrl(input) });
      return jsonResponse({ market_data: { current_price: { eur: price } } });
    });

    const config = { pricing: { coingeckoIds: { H_CACHE_TTL_POS: "h-cache-ttl-pos-id" } } };
    const ts = "2024-06-04T12:00:00.000Z";

    const r1 = await getHistoricalPrice(config, "H_CACHE_TTL_POS", ts, "eur");
    expect(r1).toBe(100);
    expect(calls).toHaveLength(1);

    price = 200;
    setNow(TTL - 1);
    const r2 = await getHistoricalPrice(config, "H_CACHE_TTL_POS", ts, "eur");
    expect(r2).toBe(100);
    expect(calls).toHaveLength(1);

    setNow(TTL);
    const r3 = await getHistoricalPrice(config, "H_CACHE_TTL_POS", ts, "eur");
    expect(r3).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("negative cache (null response) lasts 5 seconds", async () => {
    setNow(0);

    let responseOk = false;
    let responseData: unknown = { error: "not found" };
    const calls: FetchCall[] = [];
    setFetchMock(async (input) => {
      calls.push({ url: getRequestUrl(input) });
      return jsonResponse(responseData, { status: responseOk ? 200 : 404 });
    });

    const config = { pricing: { coingeckoIds: { H_CACHE_TTL_NEG: "h-cache-ttl-neg-id" } } };
    const ts = "2024-06-05T12:00:00.000Z";

    const r1 = await getHistoricalPrice(config, "H_CACHE_TTL_NEG", ts, "eur");
    expect(r1).toBeNull();
    expect(calls).toHaveLength(1);

    setNow(4999);
    const r2 = await getHistoricalPrice(config, "H_CACHE_TTL_NEG", ts, "eur");
    expect(r2).toBeNull();
    expect(calls).toHaveLength(1);

    responseOk = true;
    responseData = { market_data: { current_price: { eur: 42 } } };
    setNow(5000);
    const r3 = await getHistoricalPrice(config, "H_CACHE_TTL_NEG", ts, "eur");
    expect(r3).toBe(42);
    expect(calls).toHaveLength(2);
  });
});

describe("getHistoricalPrice — USD — unknown assets and invalid inputs", () => {
  it("returns null and avoids fetch when pricing config is missing", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 10 } } });
    const result = await getHistoricalPrice({}, "HYPE", "2024-01-15T00:00:00.000Z", "eur");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch when symbol is not in coingeckoIds config", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 10 } } });
    const config = { pricing: { coingeckoIds: { OTHER: "other-id" } } };
    const result = await getHistoricalPrice(
      config,
      "MISSING_USD_TOKEN",
      "2024-01-15T00:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for empty string symbol", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 10 } } });
    const config = { pricing: { coingeckoIds: { HYPE: "hyperliquid" } } };
    const result = await getHistoricalPrice(config, "", "2024-01-15T00:00:00.000Z", "eur");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for malformed ISO timestamp", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 10 } } });
    const config = { pricing: { coingeckoIds: { HYPE: "hyperliquid" } } };
    const result = await getHistoricalPrice(config, "HYPE", "not-a-date", "eur");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for empty string timestamp", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 10 } } });
    const config = { pricing: { coingeckoIds: { HYPE: "hyperliquid" } } };
    const result = await getHistoricalPrice(config, "HYPE", "", "eur");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null when current_price exists but usd key is missing", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { eur: 50 } } });
    const config = { pricing: { coingeckoIds: { HYPE: "hyperliquid" } } };
    const result = await getHistoricalPrice(config, "HYPE", "2024-01-15T00:00:00.000Z", "usd");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("getHistoricalPrice — USD — API failures", () => {
  it("returns null for HTTP 429 without throwing", async () => {
    const calls = mockFetchJson({ error: "rate limited" }, { status: 429 });
    const config = { pricing: { coingeckoIds: { USD_429_TOKEN: "usd-429-id" } } };
    const result = await getHistoricalPrice(
      config,
      "USD_429_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null for HTTP 404 without throwing", async () => {
    const calls = mockFetchJson({ error: "not found" }, { status: 404 });
    const config = { pricing: { coingeckoIds: { USD_404_TOKEN: "usd-404-id" } } };
    const result = await getHistoricalPrice(
      config,
      "USD_404_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null for HTTP 500 without throwing", async () => {
    const calls = mockFetchJson({ error: "server error" }, { status: 500 });
    const config = { pricing: { coingeckoIds: { USD_500_TOKEN: "usd-500-id" } } };
    const result = await getHistoricalPrice(
      config,
      "USD_500_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when market_data field is missing", async () => {
    const calls = mockFetchJson({ other_field: { current_price: { usd: 50 } } });
    const config = { pricing: { coingeckoIds: { USD_NO_MD_TOKEN: "usd-no-md-id" } } };
    const result = await getHistoricalPrice(
      config,
      "USD_NO_MD_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price.usd is a string", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: "37.5" } } });
    const config = { pricing: { coingeckoIds: { USD_STR_TOKEN: "usd-str-id" } } };
    const result = await getHistoricalPrice(
      config,
      "USD_STR_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price.usd is Infinity", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: Infinity } } });
    const config = { pricing: { coingeckoIds: { USD_INF_TOKEN: "usd-inf-id" } } };
    const result = await getHistoricalPrice(
      config,
      "USD_INF_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price.usd is negative", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: -5 } } });
    const config = { pricing: { coingeckoIds: { USD_NEG_TOKEN: "usd-neg-id" } } };
    const result = await getHistoricalPrice(
      config,
      "USD_NEG_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when fetch throws a network error", async () => {
    const calls = mockFetchReject(new Error("network down"));
    const config = { pricing: { coingeckoIds: { USD_NET_ERR_TOKEN: "usd-net-err-id" } } };
    const result = await getHistoricalPrice(
      config,
      "USD_NET_ERR_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("getHistoricalPrice — invalid input & failure paths", () => {
  it("returns null and avoids fetch when symbol is not in coingeckoIds config", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 10 } } });
    const config = { pricing: { coingeckoIds: { OTHER: "other-id" } } };
    const result = await getHistoricalPrice(
      config,
      "UNKNOWN_SYMBOL",
      "2024-01-15T00:00:00.000Z",
      "usd",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for invalid ISO timestamp (malformed string)", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 10 } } });
    const config = { pricing: { coingeckoIds: { HYPE: "hyperliquid" } } };
    const result = await getHistoricalPrice(config, "HYPE", "not-a-date", "usd");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for empty string timestamp", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 10 } } });
    const config = { pricing: { coingeckoIds: { HYPE: "hyperliquid" } } };
    const result = await getHistoricalPrice(config, "HYPE", "", "usd");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and writes negative cache for HTTP 429 response", async () => {
    const calls = mockFetchJson({ error: "rate limited" }, { status: 429 });
    const config = { pricing: { coingeckoIds: { HYPE_429: "hype-429-id" } } };
    const ts = "2024-03-10T12:00:00.000Z";

    const result = await getHistoricalPrice(config, "HYPE_429", ts, "usd");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null and writes negative cache when fetch throws network error", async () => {
    const calls = mockFetchReject(new Error("network down"));
    const config = { pricing: { coingeckoIds: { HYPE_NET_ERR: "hype-net-err-id" } } };
    const ts = "2024-03-10T12:00:00.000Z";

    const result = await getHistoricalPrice(config, "HYPE_NET_ERR", ts, "usd");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when response is missing market_data field", async () => {
    const calls = mockFetchJson({ other_field: { current_price: { usd: 50 } } });
    const config = { pricing: { coingeckoIds: { HYPE_NO_MD: "hype-no-md-id" } } };
    const result = await getHistoricalPrice(
      config,
      "HYPE_NO_MD",
      "2024-03-10T12:00:00.000Z",
      "usd",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price[currency] is negative", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: -5 } } });
    const config = { pricing: { coingeckoIds: { HYPE_NEG: "hype-neg-id" } } };
    const result = await getHistoricalPrice(config, "HYPE_NEG", "2024-03-10T12:00:00.000Z", "usd");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price[currency] is Infinity", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: Infinity } } });
    const config = { pricing: { coingeckoIds: { HYPE_INF: "hype-inf-id" } } };
    const result = await getHistoricalPrice(config, "HYPE_INF", "2024-03-10T12:00:00.000Z", "usd");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price[currency] is NaN", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: NaN } } });
    const config = { pricing: { coingeckoIds: { HYPE_NAN: "hype-nan-id" } } };
    const result = await getHistoricalPrice(config, "HYPE_NAN", "2024-03-10T12:00:00.000Z", "usd");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when current_price[currency] is a string", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: "1.23" } } });
    const config = { pricing: { coingeckoIds: { HYPE_STR: "hype-str-id" } } };
    const result = await getHistoricalPrice(config, "HYPE_STR", "2024-03-10T12:00:00.000Z", "usd");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("negative cache prevents immediate re-fetch: after 429, second call does not trigger fetch", async () => {
    setNow(0);
    const calls = mockFetchJson({ error: "rate limited" }, { status: 429 });
    const config = { pricing: { coingeckoIds: { HYPE_NEG_CACHE: "hype-neg-cache-id" } } };
    const ts = "2024-03-10T12:00:00.000Z";

    // First call returns null and writes negative cache
    const r1 = await getHistoricalPrice(config, "HYPE_NEG_CACHE", ts, "usd");
    expect(r1).toBeNull();
    expect(calls).toHaveLength(1);

    // Second call within 5 seconds should use negative cache, no new fetch
    setNow(4999);
    const r2 = await getHistoricalPrice(config, "HYPE_NEG_CACHE", ts, "usd");
    expect(r2).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("getHistoricalPrice — USD — cache behaviour", () => {
  it("cache deduplication — same (symbol, date) called twice fetches only once", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 42.5 } } });
    const config = { pricing: { coingeckoIds: { USD_DEDUP: "usd-dedup-id" } } };
    const ts = "2024-06-01T10:00:00.000Z";

    const r1 = await getHistoricalPrice(config, "USD_DEDUP", ts, "usd");
    const r2 = await getHistoricalPrice(config, "USD_DEDUP", ts, "usd");

    expect(r1).toBe(42.5);
    expect(r2).toBe(42.5);
    expect(calls).toHaveLength(1);
  });

  it("cache hit after successful fetch — second call returns same price without new fetch", async () => {
    const calls: FetchCall[] = [];
    let responseData: unknown = { market_data: { current_price: { usd: 50 } } };
    setFetchMock(async (input) => {
      calls.push({ url: getRequestUrl(input) });
      return jsonResponse(responseData);
    });

    const config = { pricing: { coingeckoIds: { USD_HIT: "usd-hit-id" } } };
    const ts = "2024-06-02T10:00:00.000Z";

    const r1 = await getHistoricalPrice(config, "USD_HIT", ts, "usd");
    expect(r1).toBe(50);
    expect(calls).toHaveLength(1);

    // Second call should return cached value without new fetch
    responseData = { market_data: { current_price: { usd: 100 } } };
    const r2 = await getHistoricalPrice(config, "USD_HIT", ts, "usd");
    expect(r2).toBe(50);
    expect(calls).toHaveLength(1);
  });

  it("negative cache — after 500 response, second call within 5s returns null without new fetch", async () => {
    setNow(0);
    const calls = mockFetchJson({ error: "server error" }, { status: 500 });

    const config = { pricing: { coingeckoIds: { USD_NEG: "usd-neg-id" } } };
    const ts = "2024-06-03T10:00:00.000Z";

    const r1 = await getHistoricalPrice(config, "USD_NEG", ts, "eur");
    expect(r1).toBeNull();
    expect(calls).toHaveLength(1);

    // Within 5 seconds, should use negative cache
    setNow(4999);
    const r2 = await getHistoricalPrice(config, "USD_NEG", ts, "eur");
    expect(r2).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("negative TTL expiry — advance Date.now by 6000ms past 5s; next call re-fetches", async () => {
    setNow(0);

    let responseOk = false;
    let responseData: unknown = { error: "not found" };
    const calls: FetchCall[] = [];
    setFetchMock(async (input) => {
      calls.push({ url: getRequestUrl(input) });
      return jsonResponse(responseData, { status: responseOk ? 200 : 404 });
    });

    const config = { pricing: { coingeckoIds: { USD_TTL_NEG: "usd-ttl-neg-id" } } };
    const ts = "2024-06-04T10:00:00.000Z";

    // First call returns null (negative cache)
    const r1 = await getHistoricalPrice(config, "USD_TTL_NEG", ts, "usd");
    expect(r1).toBeNull();
    expect(calls).toHaveLength(1);

    // Advance time by 6000ms (past 5s negative TTL)
    setNow(6000);
    responseOk = true;
    responseData = { market_data: { current_price: { usd: 37.5 } } };

    // Should re-fetch because negative cache expired
    const r2 = await getHistoricalPrice(config, "USD_TTL_NEG", ts, "usd");
    expect(r2).toBe(37.5);
    expect(calls).toHaveLength(2);
  });

  it("EUR/USD cache isolation — EUR and USD use different cache keys for same symbol+date", async () => {
    const calls: FetchCall[] = [];
    setFetchMock(async (input) => {
      calls.push({ url: getRequestUrl(input) });
      return jsonResponse({ market_data: { current_price: { eur: 35, usd: 42 } } });
    });

    const config = { pricing: { coingeckoIds: { CACHED_ISO: "cached-iso-id" } } };
    const ts = "2024-06-05T10:00:00.000Z";

    // Call EUR version first
    const eurPrice = await getHistoricalPrice(config, "CACHED_ISO", ts, "eur");
    expect(eurPrice).toBe(35);
    expect(calls).toHaveLength(1);

    // Call USD version — should fetch again because cache keys differ
    const usdPrice = await getHistoricalPrice(config, "CACHED_ISO", ts, "usd");
    expect(usdPrice).toBe(42);
    expect(calls).toHaveLength(2);

    // Verify isolation: EUR cache uses "eur:{coinGeckoId}:{date}" and USD uses "usd:{coinGeckoId}:{date}"
    // Second EUR call should use EUR cache (not USD cache)
    const eurPrice2 = await getHistoricalPrice(config, "CACHED_ISO", ts, "eur");
    expect(eurPrice2).toBe(35);
    expect(calls).toHaveLength(2);

    // Second USD call should use USD cache (not EUR cache)
    const usdPrice2 = await getHistoricalPrice(config, "CACHED_ISO", ts, "usd");
    expect(usdPrice2).toBe(42);
    expect(calls).toHaveLength(2);
  });
});

describe("getHistoricalPrice — currency key isolation (Cluster A)", () => {
  it("EUR and USD for same coin+date are stored under different cache keys — EUR fetch does NOT warm USD cache", async () => {
    const calls: FetchCall[] = [];
    setFetchMock(async (input) => {
      calls.push({ url: getRequestUrl(input) });
      return jsonResponse({ market_data: { current_price: { eur: 35, usd: 42 } } });
    });

    const config = { pricing: { coingeckoIds: { CLUSTER_A_1: "cluster-a-1-id" } } };
    const ts = "2024-06-10T10:00:00.000Z";

    // Fetch EUR first
    const eurPrice = await getHistoricalPrice(config, "CLUSTER_A_1", ts, "eur");
    expect(eurPrice).toBe(35);
    expect(calls).toHaveLength(1);

    // Fetch USD — should trigger a NEW fetch, not use EUR cache
    const usdPrice = await getHistoricalPrice(config, "CLUSTER_A_1", ts, "usd");
    expect(usdPrice).toBe(42);
    expect(calls).toHaveLength(2);
  });

  it("after fetching EUR, calling getHistoricalPrice for USD for same coin+date triggers a NEW fetch", async () => {
    const calls: FetchCall[] = [];
    setFetchMock(async (input) => {
      calls.push({ url: getRequestUrl(input) });
      return jsonResponse({ market_data: { current_price: { eur: 50, usd: 60 } } });
    });

    const config = { pricing: { coingeckoIds: { CLUSTER_A_2: "cluster-a-2-id" } } };
    const ts = "2024-06-11T10:00:00.000Z";

    // Fetch EUR
    const eurPrice = await getHistoricalPrice(config, "CLUSTER_A_2", ts, "eur");
    expect(eurPrice).toBe(50);
    expect(calls).toHaveLength(1);

    // Fetch USD — must trigger new fetch
    const usdPrice = await getHistoricalPrice(config, "CLUSTER_A_2", ts, "usd");
    expect(usdPrice).toBe(60);
    expect(calls).toHaveLength(2);
  });

  it("after fetching USD, calling getHistoricalPrice for EUR for same coin+date triggers a NEW fetch", async () => {
    const calls: FetchCall[] = [];
    setFetchMock(async (input) => {
      calls.push({ url: getRequestUrl(input) });
      return jsonResponse({ market_data: { current_price: { eur: 25, usd: 30 } } });
    });

    const config = { pricing: { coingeckoIds: { CLUSTER_A_3: "cluster-a-3-id" } } };
    const ts = "2024-06-12T10:00:00.000Z";

    // Fetch USD first
    const usdPrice = await getHistoricalPrice(config, "CLUSTER_A_3", ts, "usd");
    expect(usdPrice).toBe(30);
    expect(calls).toHaveLength(1);

    // Fetch EUR — must trigger new fetch
    const eurPrice = await getHistoricalPrice(config, "CLUSTER_A_3", ts, "eur");
    expect(eurPrice).toBe(25);
    expect(calls).toHaveLength(2);
  });

  it("EUR price is read from current_price.eur, USD from current_price.usd — they can differ and must not cross-contaminate", async () => {
    const calls: FetchCall[] = [];
    setFetchMock(async (input) => {
      calls.push({ url: getRequestUrl(input) });
      return jsonResponse({
        market_data: {
          current_price: {
            eur: 100,
            usd: 200,
          },
        },
      });
    });

    const config = { pricing: { coingeckoIds: { CLUSTER_A_4: "cluster-a-4-id" } } };
    const ts = "2024-06-13T10:00:00.000Z";

    // Fetch EUR — should get 100 from current_price.eur
    const eurPrice = await getHistoricalPrice(config, "CLUSTER_A_4", ts, "eur");
    expect(eurPrice).toBe(100);
    expect(calls).toHaveLength(1);

    // Fetch USD — should get 200 from current_price.usd, not 100 from EUR
    const usdPrice = await getHistoricalPrice(config, "CLUSTER_A_4", ts, "usd");
    expect(usdPrice).toBe(200);
    expect(calls).toHaveLength(2);

    // Verify EUR cache still returns 100, not 200
    const eurPrice2 = await getHistoricalPrice(config, "CLUSTER_A_4", ts, "eur");
    expect(eurPrice2).toBe(100);
    expect(calls).toHaveLength(2);

    // Verify USD cache still returns 200, not 100
    const usdPrice2 = await getHistoricalPrice(config, "CLUSTER_A_4", ts, "usd");
    expect(usdPrice2).toBe(200);
    expect(calls).toHaveLength(2);
  });
});
