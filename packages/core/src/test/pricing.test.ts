import { afterEach, describe, expect, it } from "bun:test";

import { __clearCaches, getEcbFxRate, getHistoricalPrice, getHyperliquidHistoricalUsdPrice, getUsdPrices } from "../services/pricing.js";

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

/**
 * Mock fetch for EUR historical price tests.
 * Handles CoinGecko, ECB, and Hyperliquid responses based on URL.
 * For ECB: returns a valid rate (1.0945) for the primary fetch.
 * For Hyperliquid: returns null (no mapping configured, so no HTTP call expected).
 * For CoinGecko: returns the provided data.
 */
function mockFetchForEurPrice(
  coinGeckoData: unknown,
  init: ResponseInit = {},
): FetchCall[] {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    const status = init.status ?? 200;

    // ECB response - only fails if status is error
    if (url.includes("data-api.ecb.europa.eu")) {
      if (status >= 200 && status < 300) {
        // Extract the date from the URL
        const dateMatch = url.match(/endPeriod=(\d{4}-\d{2}-\d{2})/);
        const dateStr = dateMatch ? dateMatch[1] : "2024-01-15";

        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {
                      "0": [1.0945, 0, 0, null, null],
                    },
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [{ id: dateStr }],
                  },
                ],
              },
            },
          }),
        } as Response;
      } else {
        return {
          ok: false,
          json: async () => ({ error: "ECB error" }),
        } as Response;
      }
    }

    // CoinGecko response
    return {
      ok: status >= 200 && status < 300,
      json: async () => coinGeckoData,
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
  __clearCaches();
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
      {} as any,
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
    const calls = mockFetchForEurPrice({ market_data: { current_price: { eur: 42.5 } } });

    const config = { pricing: { coingeckoIds: { HYPE_CASE_TEST: "hyperliquid-case-test" } } };
    const result = await getHistoricalPrice(
      config,
      "hype_case_test",
      "2024-01-15T00:00:00.000Z",
      "eur",
    );
    expect(result).toBe(42.5);
    expect(calls).toHaveLength(2); // ECB + CoinGecko
  });
});

describe("getHistoricalPrice — EUR — API failures", () => {
  it("returns null for HTTP 429 without throwing", async () => {
    const calls = mockFetchForEurPrice({ error: "rate limited" }, { status: 429 });
    const config = { pricing: { coingeckoIds: { H_429_TOKEN: "h-429-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_429_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // ECB + CoinGecko
  });

  it("returns null for HTTP 404 without throwing", async () => {
    const calls = mockFetchForEurPrice({ error: "not found" }, { status: 404 });
    const config = { pricing: { coingeckoIds: { H_404_TOKEN: "h-404-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_404_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // ECB + CoinGecko
  });

  it("returns null for HTTP 500 without throwing", async () => {
    const calls = mockFetchForEurPrice({ error: "server error" }, { status: 500 });
    const config = { pricing: { coingeckoIds: { H_500_TOKEN: "h-500-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_500_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // ECB + CoinGecko
  });

  it("returns null when market_data exists but current_price key is missing", async () => {
    const calls = mockFetchForEurPrice({ market_data: {} });
    const config = { pricing: { coingeckoIds: { H_NO_CP_TOKEN: "h-no-cp-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_NO_CP_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // ECB + CoinGecko
  });

  it("returns null when current_price exists but eur key is missing", async () => {
    const calls = mockFetchForEurPrice({ market_data: { current_price: { usd: 50 } } });
    const config = { pricing: { coingeckoIds: { H_NO_EUR_TOKEN: "h-no-eur-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_NO_EUR_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // ECB + CoinGecko
  });

  it("returns null when current_price.eur is null", async () => {
    const calls = mockFetchForEurPrice({ market_data: { current_price: { eur: null } } });
    const config = { pricing: { coingeckoIds: { H_NULL_EUR_TOKEN: "h-null-eur-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_NULL_EUR_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // ECB + CoinGecko
  });

  it("returns null when current_price.eur is a string", async () => {
    const calls = mockFetchForEurPrice({ market_data: { current_price: { eur: "37.5" } } });
    const config = { pricing: { coingeckoIds: { H_STR_EUR_TOKEN: "h-str-eur-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_STR_EUR_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // ECB + CoinGecko
  });

  it("returns null when current_price.eur is Infinity", async () => {
    const calls = mockFetchForEurPrice({ market_data: { current_price: { eur: Infinity } } });
    const config = { pricing: { coingeckoIds: { H_INF_EUR_TOKEN: "h-inf-eur-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_INF_EUR_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // ECB + CoinGecko
  });

  it("returns null when current_price.eur is negative", async () => {
    const calls = mockFetchForEurPrice({ market_data: { current_price: { eur: -5 } } });
    const config = { pricing: { coingeckoIds: { H_NEG_EUR_TOKEN: "h-neg-eur-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_NEG_EUR_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // ECB + CoinGecko
  });

  it("returns null when fetch throws a network error", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const config = { pricing: { coingeckoIds: { H_NET_ERR_TOKEN: "h-net-err-id" } } };
    const result = await getHistoricalPrice(
      config,
      "H_NET_ERR_TOKEN",
      "2024-03-10T12:00:00.000Z",
      "eur",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // ECB + CoinGecko (both throw)
  });
});

describe("getHistoricalPrice — EUR — caching", () => {
  it("deduplication — same (asset, date) called twice fetches only once", async () => {
    const calls = mockFetchForEurPrice({ market_data: { current_price: { eur: 55 } } });
    const config = { pricing: { coingeckoIds: { H_CACHE_DEDUP: "h-cache-dedup-id" } } };
    const ts = "2024-06-01T10:00:00.000Z";

    const r1 = await getHistoricalPrice(config, "H_CACHE_DEDUP", ts, "eur");
    const r2 = await getHistoricalPrice(config, "H_CACHE_DEDUP", ts, "eur");

    expect(r1).toBe(55);
    expect(r2).toBe(55);
    expect(calls).toHaveLength(2); // ECB + CoinGecko on first call, cache hit on second
  });

  it("deduplication — different dates for the same asset each trigger their own fetch", async () => {
    const calls = mockFetchForEurPrice({ market_data: { current_price: { eur: 66 } } });
    const config = { pricing: { coingeckoIds: { H_CACHE_DATES_A: "h-cache-dates-a-id" } } };

    await getHistoricalPrice(config, "H_CACHE_DATES_A", "2024-06-01T10:00:00.000Z", "eur");
    await getHistoricalPrice(config, "H_CACHE_DATES_A", "2024-06-02T10:00:00.000Z", "eur");

    expect(calls).toHaveLength(4); // 2 calls per date (ECB + CoinGecko)
  });

  it("deduplication — different assets on the same date each trigger their own fetch", async () => {
    const calls = mockFetchForEurPrice({ market_data: { current_price: { eur: 77 } } });
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

    expect(calls).toHaveLength(3); // ECB (cached for both) + CoinGecko + CoinGecko
  });

  it("positive cache lasts 24 hours (HISTORICAL_PRICE_CACHE_TTL_MS)", async () => {
    const TTL = 24 * 60 * 60 * 1000;
    setNow(0);

    let price = 100;
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });

      // ECB response
      if (url.includes("data-api.ecb.europa.eu")) {
        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {
                      "0": [1.0945, 0, 0, null, null],
                    },
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [{ id: "2024-06-04" }],
                  },
                ],
              },
            },
          }),
        } as Response;
      }

      // CoinGecko response
      return {
        ok: true,
        json: async () => ({ market_data: { current_price: { eur: price } } }),
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { coingeckoIds: { H_CACHE_TTL_POS: "h-cache-ttl-pos-id" } } };
    const ts = "2024-06-04T12:00:00.000Z";

    const r1 = await getHistoricalPrice(config, "H_CACHE_TTL_POS", ts, "eur");
    expect(r1).toBe(100);
    expect(calls).toHaveLength(2); // ECB + CoinGecko

    price = 200;
    setNow(TTL - 1);
    const r2 = await getHistoricalPrice(config, "H_CACHE_TTL_POS", ts, "eur");
    expect(r2).toBe(100);
    expect(calls).toHaveLength(2); // Cache hit, no new calls

    setNow(TTL);
    const r3 = await getHistoricalPrice(config, "H_CACHE_TTL_POS", ts, "eur");
    expect(r3).toBe(200);
    expect(calls).toHaveLength(4); // ECB + CoinGecko again
  });

  it("negative cache (null response) lasts 5 seconds", async () => {
    setNow(0);

    let responseOk = false;
    let responseData: unknown = { error: "not found" };
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });

      // ECB response
      if (url.includes("data-api.ecb.europa.eu")) {
        if (responseOk) {
          // Extract the date from the URL
          const dateMatch = url.match(/endPeriod=(\d{4}-\d{2}-\d{2})/);
          const dateStr = dateMatch ? dateMatch[1] : "2024-06-05";

          return {
            ok: true,
            json: async () => ({
              dataSets: [
                {
                  series: {
                    "0:0:0:0:0": {
                      observations: {
                        "0": [1.0945, 0, 0, null, null],
                      },
                    },
                  },
                },
              ],
              structure: {
                dimensions: {
                  observation: [
                    {
                      values: [{ id: dateStr }],
                    },
                  ],
                },
              },
            }),
          } as Response;
        } else {
          return {
            ok: false,
            json: async () => ({ error: "ECB error" }),
          } as Response;
        }
      }

      // CoinGecko response
      return {
        ok: responseOk,
        json: async () => responseData,
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { coingeckoIds: { H_CACHE_TTL_NEG: "h-cache-ttl-neg-id" } } };
    const ts = "2024-06-05T12:00:00.000Z";

    const r1 = await getHistoricalPrice(config, "H_CACHE_TTL_NEG", ts, "eur");
    expect(r1).toBeNull();
    expect(calls).toHaveLength(2); // ECB + CoinGecko

    setNow(4999);
    const r2 = await getHistoricalPrice(config, "H_CACHE_TTL_NEG", ts, "eur");
    expect(r2).toBeNull();
    expect(calls).toHaveLength(2); // Cache hit, no new calls

    responseOk = true;
    responseData = { market_data: { current_price: { eur: 42 } } };
    setNow(5000);
    const r3 = await getHistoricalPrice(config, "H_CACHE_TTL_NEG", ts, "eur");
    expect(r3).toBe(42);
    expect(calls).toHaveLength(4); // ECB + CoinGecko again
  });
});

describe("getHistoricalPrice — USD — unknown assets and invalid inputs", () => {
  it("returns null and avoids fetch when pricing config is missing", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 10 } } });
    const result = await getHistoricalPrice({} as any, "HYPE", "2024-01-15T00:00:00.000Z", "usd");
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
      "usd",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for empty string symbol", async () => {
    const calls = mockFetchJson({ market_data: { current_price: { usd: 10 } } });
    const config = { pricing: { coingeckoIds: { HYPE: "hyperliquid" } } };
    const result = await getHistoricalPrice(config, "", "2024-01-15T00:00:00.000Z", "usd");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for malformed ISO timestamp", async () => {
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
      "usd",
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
      "usd",
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
      "usd",
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
      "usd",
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
      "usd",
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
      "usd",
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
      "usd",
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
      "usd",
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
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return {
        ok: true,
        json: async () => responseData,
      } as Response;
    }) as unknown as typeof fetch;

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
    const calls = mockFetchForEurPrice({ error: "server error" }, { status: 500 });

    const config = { pricing: { coingeckoIds: { USD_NEG: "usd-neg-id" } } };
    const ts = "2024-06-03T10:00:00.000Z";

    const r1 = await getHistoricalPrice(config, "USD_NEG", ts, "eur");
    expect(r1).toBeNull();
    expect(calls).toHaveLength(2); // ECB + CoinGecko

    // Within 5 seconds, should use negative cache
    setNow(4999);
    const r2 = await getHistoricalPrice(config, "USD_NEG", ts, "eur");
    expect(r2).toBeNull();
    expect(calls).toHaveLength(2); // Cache hit, no new calls
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
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });

      // ECB response
      if (url.includes("data-api.ecb.europa.eu")) {
        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {
                      "0": [1.0945, 0, 0, null, null],
                    },
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [{ id: "2024-06-05" }],
                  },
                ],
              },
            },
          }),
        } as Response;
      }

      // CoinGecko response
      return {
        ok: true,
        json: async () => ({ market_data: { current_price: { eur: 35, usd: 42 } } }),
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { coingeckoIds: { CACHED_ISO: "cached-iso-id" } } };
    const ts = "2024-06-05T10:00:00.000Z";

    // Call EUR version first - makes ECB + CoinGecko calls
    const eurPrice = await getHistoricalPrice(config, "CACHED_ISO", ts, "eur");
    expect(eurPrice).toBe(35);
    expect(calls).toHaveLength(2); // ECB + CoinGecko

    // Call USD version — should fetch again because cache keys differ - makes CoinGecko call
    const usdPrice = await getHistoricalPrice(config, "CACHED_ISO", ts, "usd");
    expect(usdPrice).toBe(42);
    expect(calls).toHaveLength(3); // ECB + CoinGecko + CoinGecko (for USD)

    // Verify isolation: EUR cache uses "eur:{coinGeckoId}:{date}" and USD uses "usd:{coinGeckoId}:{date}"
    // Second EUR call should use EUR cache (not USD cache)
    const eurPrice2 = await getHistoricalPrice(config, "CACHED_ISO", ts, "eur");
    expect(eurPrice2).toBe(35);
    expect(calls).toHaveLength(3); // Cache hit, no new calls

    // Second USD call should use USD cache (not EUR cache)
    const usdPrice2 = await getHistoricalPrice(config, "CACHED_ISO", ts, "usd");
    expect(usdPrice2).toBe(42);
    expect(calls).toHaveLength(3); // Cache hit, no new calls
  });
});

describe("getHistoricalPrice — currency key isolation (Cluster A)", () => {
  it("EUR and USD for same coin+date are stored under different cache keys — EUR fetch does NOT warm USD cache", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });

      // ECB response
      if (url.includes("data-api.ecb.europa.eu")) {
        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {
                      "0": [1.0945, 0, 0, null, null],
                    },
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [{ id: "2024-06-10" }],
                  },
                ],
              },
            },
          }),
        } as Response;
      }

      // CoinGecko response
      return {
        ok: true,
        json: async () => ({ market_data: { current_price: { eur: 35, usd: 42 } } }),
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { coingeckoIds: { CLUSTER_A_1: "cluster-a-1-id" } } };
    const ts = "2024-06-10T10:00:00.000Z";

    // Fetch EUR first - makes ECB + CoinGecko calls
    const eurPrice = await getHistoricalPrice(config, "CLUSTER_A_1", ts, "eur");
    expect(eurPrice).toBe(35);
    expect(calls).toHaveLength(2); // ECB + CoinGecko

    // Fetch USD — should trigger a NEW fetch, not use EUR cache - makes CoinGecko call
    const usdPrice = await getHistoricalPrice(config, "CLUSTER_A_1", ts, "usd");
    expect(usdPrice).toBe(42);
    expect(calls).toHaveLength(3); // ECB + CoinGecko + CoinGecko (for USD)
  });

  it("after fetching EUR, calling getHistoricalPrice for USD for same coin+date triggers a NEW fetch", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });

      // ECB response
      if (url.includes("data-api.ecb.europa.eu")) {
        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {
                      "0": [1.0945, 0, 0, null, null],
                    },
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [{ id: "2024-06-11" }],
                  },
                ],
              },
            },
          }),
        } as Response;
      }

      // CoinGecko response
      return {
        ok: true,
        json: async () => ({ market_data: { current_price: { eur: 50, usd: 60 } } }),
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { coingeckoIds: { CLUSTER_A_2: "cluster-a-2-id" } } };
    const ts = "2024-06-11T10:00:00.000Z";

    // Fetch EUR - makes ECB + CoinGecko calls
    const eurPrice = await getHistoricalPrice(config, "CLUSTER_A_2", ts, "eur");
    expect(eurPrice).toBe(50);
    expect(calls).toHaveLength(2); // ECB + CoinGecko

    // Fetch USD — must trigger new fetch - makes CoinGecko call
    const usdPrice = await getHistoricalPrice(config, "CLUSTER_A_2", ts, "usd");
    expect(usdPrice).toBe(60);
    expect(calls).toHaveLength(3); // ECB + CoinGecko + CoinGecko (for USD)
  });

  it("after fetching USD, calling getHistoricalPrice for EUR for same coin+date triggers a NEW fetch", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });

      // ECB response
      if (url.includes("data-api.ecb.europa.eu")) {
        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {
                      "0": [1.0945, 0, 0, null, null],
                    },
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [{ id: "2024-06-12" }],
                  },
                ],
              },
            },
          }),
        } as Response;
      }

      // CoinGecko response
      return {
        ok: true,
        json: async () => ({ market_data: { current_price: { eur: 25, usd: 30 } } }),
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { coingeckoIds: { CLUSTER_A_3: "cluster-a-3-id" } } };
    const ts = "2024-06-12T10:00:00.000Z";

    // Fetch USD first - makes CoinGecko call
    const usdPrice = await getHistoricalPrice(config, "CLUSTER_A_3", ts, "usd");
    expect(usdPrice).toBe(30);
    expect(calls).toHaveLength(1); // CoinGecko

    // Fetch EUR — must trigger new fetch - makes ECB + CoinGecko calls
    const eurPrice = await getHistoricalPrice(config, "CLUSTER_A_3", ts, "eur");
    expect(eurPrice).toBe(25);
    expect(calls).toHaveLength(3); // CoinGecko + ECB + CoinGecko (for EUR)
  });

  it("EUR price is read from current_price.eur, USD from current_price.usd — they can differ and must not cross-contaminate", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });

      // ECB response
      if (url.includes("data-api.ecb.europa.eu")) {
        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {
                      "0": [1.0945, 0, 0, null, null],
                    },
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [{ id: "2024-06-13" }],
                  },
                ],
              },
            },
          }),
        } as Response;
      }

      // CoinGecko response
      return {
        ok: true,
        json: async () => ({
          market_data: {
            current_price: {
              eur: 100,
              usd: 200,
            },
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { coingeckoIds: { CLUSTER_A_4: "cluster-a-4-id" } } };
    const ts = "2024-06-13T10:00:00.000Z";

    // Fetch EUR — should get 100 from current_price.eur - makes ECB + CoinGecko calls
    const eurPrice = await getHistoricalPrice(config, "CLUSTER_A_4", ts, "eur");
    expect(eurPrice).toBe(100);
    expect(calls).toHaveLength(2); // ECB + CoinGecko

    // Fetch USD — should get 200 from current_price.usd, not 100 from EUR - makes CoinGecko call
    const usdPrice = await getHistoricalPrice(config, "CLUSTER_A_4", ts, "usd");
    expect(usdPrice).toBe(200);
    expect(calls).toHaveLength(3); // ECB + CoinGecko + CoinGecko (for USD)

    // Verify EUR cache still returns 100, not 200
    const eurPrice2 = await getHistoricalPrice(config, "CLUSTER_A_4", ts, "eur");
    expect(eurPrice2).toBe(100);
    expect(calls).toHaveLength(3); // Cache hit, no new calls

    // Verify USD cache still returns 200, not 100
    const usdPrice2 = await getHistoricalPrice(config, "CLUSTER_A_4", ts, "usd");
    expect(usdPrice2).toBe(200);
    expect(calls).toHaveLength(3); // Cache hit, no new calls
  });
});

describe("getHistoricalPrice EUR — fallback chain (source availability combinations)", () => {
  /**
   * Smart fetch mock that dispatches on URL pattern.
   * Supports Hyperliquid (POST), ECB (GET), and CoinGecko (GET).
   */
  function mockMultiSourceFetch(responses: Record<string, { ok: boolean; data: unknown }>) {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url });

      for (const [pattern, resp] of Object.entries(responses)) {
        if (url.includes(pattern)) {
          return {
            ok: resp.ok,
            json: async () => resp.data,
          } as Response;
        }
      }

      throw new Error(`Unmocked URL: ${url}`);
    }) as unknown as typeof fetch;
    return calls;
  }

  it("scenario 1: both HL and ECB succeed → EUR price returned (hlUsdPrice / ecbRate), CoinGecko NOT called", async () => {
    const calls = mockMultiSourceFetch({
      "hyperliquid.xyz": {
        ok: true,
        data: [{ c: "37.42", t: 1234 }],
      },
      "ecb.europa.eu": {
        ok: true,
        data: {
          dataSets: [
            {
              series: {
                "0:0:0:0:0": {
                  observations: {
                    "0": [1.1, 0, 0, null, null],
                  },
                },
              },
            },
          ],
          structure: {
            dimensions: {
              observation: [
                {
                  values: [{ id: "2024-07-01" }],
                },
              ],
            },
          },
        },
      },
      "coingecko.com": {
        ok: true,
        data: { market_data: { current_price: { eur: 999 } } },
      },
    });

    const config = {
      pricing: {
        coingeckoIds: { WHYPE: "hyperliquid" },
        hyperliquidSymbols: { WHYPE: "HYPE" },
      },
    };

    const result = await getHistoricalPrice(config, "WHYPE", "2024-07-01T00:00:00.000Z", "eur");

    // Expected: 37.42 / 1.1 ≈ 34.018...
    expect(result).toBeCloseTo(37.42 / 1.1, 5);

    // Should have called HL + ECB, but NOT CoinGecko
    const nonCoinGeckoCalls = calls.filter((c) => !c.url.includes("coingecko.com"));
    expect(nonCoinGeckoCalls).toHaveLength(2);
    expect(calls.some((c) => c.url.includes("hyperliquid.xyz"))).toBe(true);
    expect(calls.some((c) => c.url.includes("ecb.europa.eu"))).toBe(true);
    expect(calls.some((c) => c.url.includes("coingecko.com"))).toBe(false);
  });

  it("scenario 2: HL succeeds, ECB returns null → CoinGecko EUR fallback called, CoinGecko result returned", async () => {
    const calls = mockMultiSourceFetch({
      "hyperliquid.xyz": {
        ok: true,
        data: [{ c: "37.42", t: 1234 }],
      },
      "ecb.europa.eu": {
        ok: false,
        data: { error: "ECB error" },
      },
      "coingecko.com": {
        ok: true,
        data: { market_data: { current_price: { eur: 34.0 } } },
      },
    });

    const config = {
      pricing: {
        coingeckoIds: { WHYPE: "hyperliquid" },
        hyperliquidSymbols: { WHYPE: "HYPE" },
      },
    };

    const result = await getHistoricalPrice(config, "WHYPE", "2024-07-02T00:00:00.000Z", "eur");

    expect(result).toBe(34.0);
    expect(calls.some((c) => c.url.includes("hyperliquid.xyz"))).toBe(true);
    expect(calls.some((c) => c.url.includes("ecb.europa.eu"))).toBe(true);
    expect(calls.some((c) => c.url.includes("coingecko.com"))).toBe(true);
  });

  it("scenario 3: HL returns null, ECB succeeds → CoinGecko EUR fallback called, CoinGecko result returned", async () => {
    const calls = mockMultiSourceFetch({
      "hyperliquid.xyz": {
        ok: true,
        data: [],
      },
      "ecb.europa.eu": {
        ok: true,
        data: {
          dataSets: [
            {
              series: {
                "0:0:0:0:0": {
                  observations: {
                    "0": [1.1, 0, 0, null, null],
                  },
                },
              },
            },
          ],
          structure: {
            dimensions: {
              observation: [
                {
                  values: [{ id: "2024-07-03" }],
                },
              ],
            },
          },
        },
      },
      "coingecko.com": {
        ok: true,
        data: { market_data: { current_price: { eur: 34.0 } } },
      },
    });

    const config = {
      pricing: {
        coingeckoIds: { WHYPE: "hyperliquid" },
        hyperliquidSymbols: { WHYPE: "HYPE" },
      },
    };

    const result = await getHistoricalPrice(config, "WHYPE", "2024-07-03T00:00:00.000Z", "eur");

    expect(result).toBe(34.0);
    expect(calls.some((c) => c.url.includes("hyperliquid.xyz"))).toBe(true);
    expect(calls.some((c) => c.url.includes("ecb.europa.eu"))).toBe(true);
    expect(calls.some((c) => c.url.includes("coingecko.com"))).toBe(true);
  });

  it("scenario 4: both HL and ECB return null → CoinGecko EUR fallback called, CoinGecko result returned", async () => {
    const calls = mockMultiSourceFetch({
      "hyperliquid.xyz": {
        ok: true,
        data: [],
      },
      "ecb.europa.eu": {
        ok: false,
        data: { error: "ECB error" },
      },
      "coingecko.com": {
        ok: true,
        data: { market_data: { current_price: { eur: 34.0 } } },
      },
    });

    const config = {
      pricing: {
        coingeckoIds: { WHYPE: "hyperliquid" },
        hyperliquidSymbols: { WHYPE: "HYPE" },
      },
    };

    const result = await getHistoricalPrice(config, "WHYPE", "2024-07-04T00:00:00.000Z", "eur");

    expect(result).toBe(34.0);
    expect(calls.some((c) => c.url.includes("hyperliquid.xyz"))).toBe(true);
    expect(calls.some((c) => c.url.includes("ecb.europa.eu"))).toBe(true);
    expect(calls.some((c) => c.url.includes("coingecko.com"))).toBe(true);
  });

  it("scenario 5: CoinGecko also returns null → null returned", async () => {
    const calls = mockMultiSourceFetch({
      "hyperliquid.xyz": {
        ok: true,
        data: [],
      },
      "ecb.europa.eu": {
        ok: false,
        data: { error: "ECB error" },
      },
      "coingecko.com": {
        ok: false,
        data: { error: "not found" },
      },
    });

    const config = {
      pricing: {
        coingeckoIds: { WHYPE: "hyperliquid" },
        hyperliquidSymbols: { WHYPE: "HYPE" },
      },
    };

    const result = await getHistoricalPrice(config, "WHYPE", "2024-07-05T00:00:00.000Z", "eur");

    expect(result).toBeNull();
    expect(calls.some((c) => c.url.includes("hyperliquid.xyz"))).toBe(true);
    expect(calls.some((c) => c.url.includes("ecb.europa.eu"))).toBe(true);
    expect(calls.some((c) => c.url.includes("coingecko.com"))).toBe(true);
  });

  it("scenario 6: HL + ECB succeed, cached result returned on second call → only 2 total HTTP calls (HL + ECB), not 4", async () => {
    const calls = mockMultiSourceFetch({
      "hyperliquid.xyz": {
        ok: true,
        data: [{ c: "37.42", t: 1234 }],
      },
      "ecb.europa.eu": {
        ok: true,
        data: {
          dataSets: [
            {
              series: {
                "0:0:0:0:0": {
                  observations: {
                    "0": [1.1, 0, 0, null, null],
                  },
                },
              },
            },
          ],
          structure: {
            dimensions: {
              observation: [
                {
                  values: [{ id: "2024-07-06" }],
                },
              ],
            },
          },
        },
      },
      "coingecko.com": {
        ok: true,
        data: { market_data: { current_price: { eur: 999 } } },
      },
    });

    const config = {
      pricing: {
        coingeckoIds: { WHYPE: "hyperliquid" },
        hyperliquidSymbols: { WHYPE: "HYPE" },
      },
    };

    const ts = "2024-07-06T00:00:00.000Z";

    // First call
    const result1 = await getHistoricalPrice(config, "WHYPE", ts, "eur");
    expect(result1).toBeCloseTo(37.42 / 1.1, 5);
    expect(calls).toHaveLength(2); // HL + ECB

    // Second call should use cache
    const result2 = await getHistoricalPrice(config, "WHYPE", ts, "eur");
    expect(result2).toBeCloseTo(37.42 / 1.1, 5);
    expect(calls).toHaveLength(2); // No new calls
  });
});

describe("getHistoricalPrice EUR — fallback chain (composition edge values)", () => {
  it("ECB rate = 1.0 → composed EUR price equals HL USD price exactly", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });

      // ECB response with rate = 1.0
      if (url.includes("data-api.ecb.europa.eu")) {
        const dateMatch = url.match(/endPeriod=(\d{4}-\d{2}-\d{2})/);
        const dateStr = dateMatch ? dateMatch[1] : "2024-07-01";
        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {
                      "0": [1.0, 0, 0, null, null],
                    },
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [{ id: dateStr }],
                  },
                ],
              },
            },
          }),
        } as Response;
      }

      // Hyperliquid response with USD price 50.0
      if (url.includes("api.hyperliquid.xyz")) {
        return {
          ok: true,
          json: async () => [{ c: "50.0" }],
        } as Response;
      }

      // CoinGecko fallback (should not be called)
      return {
        ok: true,
        json: async () => ({ market_data: { current_price: { eur: 999 } } }),
      } as Response;
    }) as unknown as typeof fetch;

    const config = {
      pricing: {
        coingeckoIds: { EDGE_RATE_1: "edge-rate-1-id" },
        hyperliquidSymbols: { EDGE_RATE_1: "EDGE_RATE_1" },
      },
    };

    const result = await getHistoricalPrice(config, "EDGE_RATE_1", "2024-07-01T00:00:00.000Z", "eur");
    expect(result).toBe(50.0); // 50.0 / 1.0 = 50.0
    // Should only call Hyperliquid + ECB, not CoinGecko
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("ECB rate = 2.0 → composed EUR price is half the USD price", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });

      // ECB response with rate = 2.0
      if (url.includes("data-api.ecb.europa.eu")) {
        const dateMatch = url.match(/endPeriod=(\d{4}-\d{2}-\d{2})/);
        const dateStr = dateMatch ? dateMatch[1] : "2024-07-02";
        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {
                      "0": [2.0, 0, 0, null, null],
                    },
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [{ id: dateStr }],
                  },
                ],
              },
            },
          }),
        } as Response;
      }

      // Hyperliquid response with USD price 100.0
      if (url.includes("api.hyperliquid.xyz")) {
        return {
          ok: true,
          json: async () => [{ c: "100.0" }],
        } as Response;
      }

      // CoinGecko fallback (should not be called)
      return {
        ok: true,
        json: async () => ({ market_data: { current_price: { eur: 999 } } }),
      } as Response;
    }) as unknown as typeof fetch;

    const config = {
      pricing: {
        coingeckoIds: { EDGE_RATE_2: "edge-rate-2-id" },
        hyperliquidSymbols: { EDGE_RATE_2: "EDGE_RATE_2" },
      },
    };

    const result = await getHistoricalPrice(config, "EDGE_RATE_2", "2024-07-02T00:00:00.000Z", "eur");
    expect(result).toBe(50.0); // 100.0 / 2.0 = 50.0
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("HL USD price = 0 → composition produces 0, rejected (not > 0), falls back to CoinGecko", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });

      // ECB response with valid rate
      if (url.includes("data-api.ecb.europa.eu")) {
        const dateMatch = url.match(/endPeriod=(\d{4}-\d{2}-\d{2})/);
        const dateStr = dateMatch ? dateMatch[1] : "2024-07-03";
        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {
                      "0": [1.0945, 0, 0, null, null],
                    },
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [{ id: dateStr }],
                  },
                ],
              },
            },
          }),
        } as Response;
      }

      // Hyperliquid response with USD price 0
      if (url.includes("api.hyperliquid.xyz")) {
        return {
          ok: true,
          json: async () => [{ c: "0" }],
        } as Response;
      }

      // CoinGecko fallback (should be called because composition failed)
      return {
        ok: true,
        json: async () => ({ market_data: { current_price: { eur: 42.5 } } }),
      } as Response;
    }) as unknown as typeof fetch;

    const config = {
      pricing: {
        coingeckoIds: { EDGE_ZERO_PRICE: "edge-zero-price-id" },
        hyperliquidSymbols: { EDGE_ZERO_PRICE: "EDGE_ZERO_PRICE" },
      },
    };

    const result = await getHistoricalPrice(config, "EDGE_ZERO_PRICE", "2024-07-03T00:00:00.000Z", "eur");
    expect(result).toBe(42.5); // Falls back to CoinGecko
    // Should call Hyperliquid + ECB + CoinGecko (composition failed, so fallback)
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("ECB rate very small (0.0001) → composition produces large finite number, accepted", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });

      // ECB response with very small rate
      if (url.includes("data-api.ecb.europa.eu")) {
        const dateMatch = url.match(/endPeriod=(\d{4}-\d{2}-\d{2})/);
        const dateStr = dateMatch ? dateMatch[1] : "2024-07-04";
        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {
                      "0": [0.0001, 0, 0, null, null],
                    },
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [{ id: dateStr }],
                  },
                ],
              },
            },
          }),
        } as Response;
      }

      // Hyperliquid response with USD price 1.0
      if (url.includes("api.hyperliquid.xyz")) {
        return {
          ok: true,
          json: async () => [{ c: "1.0" }],
        } as Response;
      }

      // CoinGecko fallback (should not be called)
      return {
        ok: true,
        json: async () => ({ market_data: { current_price: { eur: 999 } } }),
      } as Response;
    }) as unknown as typeof fetch;

    const config = {
      pricing: {
        coingeckoIds: { EDGE_SMALL_RATE: "edge-small-rate-id" },
        hyperliquidSymbols: { EDGE_SMALL_RATE: "EDGE_SMALL_RATE" },
      },
    };

    const result = await getHistoricalPrice(config, "EDGE_SMALL_RATE", "2024-07-04T00:00:00.000Z", "eur");
    expect(result).toBe(10000.0); // 1.0 / 0.0001 = 10000.0
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("HL price = 1e308, ECB rate = 1e-308 → product overflows to Infinity, rejected, falls back to CoinGecko", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });

      // ECB response with very small rate
      if (url.includes("data-api.ecb.europa.eu")) {
        const dateMatch = url.match(/endPeriod=(\d{4}-\d{2}-\d{2})/);
        const dateStr = dateMatch ? dateMatch[1] : "2024-07-05";
        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {
                      "0": [1e-308, 0, 0, null, null],
                    },
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [{ id: dateStr }],
                  },
                ],
              },
            },
          }),
        } as Response;
      }

      // Hyperliquid response with very large USD price
      if (url.includes("api.hyperliquid.xyz")) {
        return {
          ok: true,
          json: async () => [{ c: "1e308" }],
        } as Response;
      }

      // CoinGecko fallback (should be called because composition overflowed)
      return {
        ok: true,
        json: async () => ({ market_data: { current_price: { eur: 55.5 } } }),
      } as Response;
    }) as unknown as typeof fetch;

    const config = {
      pricing: {
        coingeckoIds: { EDGE_OVERFLOW: "edge-overflow-id" },
        hyperliquidSymbols: { EDGE_OVERFLOW: "EDGE_OVERFLOW" },
      },
    };

    const result = await getHistoricalPrice(config, "EDGE_OVERFLOW", "2024-07-05T00:00:00.000Z", "eur");
    expect(result).toBe(55.5); // Falls back to CoinGecko because composition overflowed
    // Should call Hyperliquid + ECB + CoinGecko (composition failed, so fallback)
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe("getEcbFxRate — network failures and negative caching", () => {
   it("HTTP 429 returns null and writes negative cache", async () => {
     const calls = mockFetchJson({ error: "rate limited" }, { status: 429 });
     const result = await getEcbFxRate("2024-06-15T00:00:00.000Z");
     expect(result).toBeNull();
     expect(calls).toHaveLength(1);
   });

  it("HTTP 500 returns null", async () => {
    const calls = mockFetchJson({ error: "server error" }, { status: 500 });
    const result = await getEcbFxRate("2024-06-15T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("HTTP 404 returns null", async () => {
    const calls = mockFetchJson({ error: "not found" }, { status: 404 });
    const result = await getEcbFxRate("2024-06-15T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("network throw (fetch rejects) returns null", async () => {
    const calls = mockFetchReject(new Error("network down"));
    const result = await getEcbFxRate("2024-06-15T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("negative cache prevents re-fetch: call once (gets 500), then immediately call again → total of only 1 HTTP call", async () => {
    setNow(0);
    const calls = mockFetchJson({ error: "server error" }, { status: 500 });

    const r1 = await getEcbFxRate("2024-06-15T00:00:00.000Z");
    expect(r1).toBeNull();
    expect(calls).toHaveLength(1);

    // Second call within 5 seconds should use negative cache
    setNow(4999);
    const r2 = await getEcbFxRate("2024-06-15T00:00:00.000Z");
    expect(r2).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("positive cache prevents re-fetch: call once with valid response, call again within 24h → total of only 1 HTTP call", async () => {
    setNow(0);
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return {
        ok: true,
        json: async () => ({
          dataSets: [
            {
              series: {
                "0:0:0:0:0": {
                  observations: {
                    "0": [1.0875],
                  },
                },
              },
            },
          ],
          structure: {
            dimensions: {
              observation: [
                {
                  values: [{ id: "2024-06-15" }],
                },
              ],
            },
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const r1 = await getEcbFxRate("2024-06-15T00:00:00.000Z");
    expect(r1).toBe(1.0875);
    expect(calls).toHaveLength(1);

    // Call again within 24 hours
    setNow(24 * 60 * 60 * 1000 - 1);
    const r2 = await getEcbFxRate("2024-06-15T00:00:00.000Z");
    expect(r2).toBe(1.0875);
    expect(calls).toHaveLength(1);
  });

  it("primary fetch succeeds but has 0 observations, fallback fetch throws → returns null", async () => {
    setNow(0);
    let callIndex = 0;
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      callIndex++;

      if (callIndex === 1) {
        // Primary fetch: no observations for weekend date
        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {},
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [{ id: "2024-06-15" }],
                  },
                ],
              },
            },
          }),
        } as Response;
      } else {
        // Fallback fetch throws
        throw new Error("network error on fallback");
      }
    }) as unknown as typeof fetch;

    const result = await getEcbFxRate("2024-06-15T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("primary fetch 429, no fallback attempted → null returned, exactly 1 HTTP call total", async () => {
    const calls = mockFetchJson({ error: "rate limited" }, { status: 429 });
    const result = await getEcbFxRate("2024-06-15T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("getEcbFxRate — malformed ECB response shapes", () => {
  it("returns null when top-level response is an array", async () => {
    const calls = mockFetchJson(["not", "an", "object"]);
    const result = await getEcbFxRate("2024-06-14T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // primary + fallback
  });

  it("returns null when top-level response is a string", async () => {
    const calls = mockFetchJson("not an object");
    const result = await getEcbFxRate("2024-06-15T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // primary + fallback
  });

  it("returns null when top-level response is null", async () => {
    const calls = mockFetchJson(null);
    const result = await getEcbFxRate("2024-06-16T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // primary + fallback
  });

  it("returns null when top-level response is a number", async () => {
    const calls = mockFetchJson(42);
    const result = await getEcbFxRate("2024-06-17T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // primary + fallback
  });

  it("returns null when dataSets field is missing entirely", async () => {
    const calls = mockFetchJson({ structure: { dimensions: { observation: [{ values: [] }] } } });
    const result = await getEcbFxRate("2024-06-18T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // primary + fallback
  });

  it("returns null when dataSets is an empty array", async () => {
    const calls = mockFetchJson({ dataSets: [] });
    const result = await getEcbFxRate("2024-06-19T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // primary + fallback
  });

  it("returns null when series[\"0:0:0:0:0\"] key is missing", async () => {
    const calls = mockFetchJson({
      dataSets: [{ series: { "1:1:1:1:1": { observations: { "0": [1.0945] } } } }],
    });
    const result = await getEcbFxRate("2024-06-20T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // primary + fallback
  });

  it("returns null when observations field is missing from series", async () => {
    const calls = mockFetchJson({
      dataSets: [{ series: { "0:0:0:0:0": { other_field: {} } } }],
    });
    const result = await getEcbFxRate("2024-06-21T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // primary + fallback
  });

  it("returns null when rate value is 0", async () => {
    const calls = mockFetchJson({
      dataSets: [
        {
          series: {
            "0:0:0:0:0": {
              observations: { "0": [0] },
            },
          },
        },
      ],
      structure: {
        dimensions: {
          observation: [{ values: [{ id: "2024-06-22" }] }],
        },
      },
    });
    const result = await getEcbFxRate("2024-06-22T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // primary + fallback
  });

  it("returns null when rate value is negative", async () => {
    const calls = mockFetchJson({
      dataSets: [
        {
          series: {
            "0:0:0:0:0": {
              observations: { "0": [-1.09] },
            },
          },
        },
      ],
      structure: {
        dimensions: {
          observation: [{ values: [{ id: "2024-06-23" }] }],
        },
      },
    });
    const result = await getEcbFxRate("2024-06-23T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // primary + fallback
  });

  it("returns null when rate value is null", async () => {
    const calls = mockFetchJson({
      dataSets: [
        {
          series: {
            "0:0:0:0:0": {
              observations: { "0": [null] },
            },
          },
        },
      ],
      structure: {
        dimensions: {
          observation: [{ values: [{ id: "2024-06-24" }] }],
        },
      },
    });
    const result = await getEcbFxRate("2024-06-24T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // primary + fallback
  });

  it("returns null when rate value is a string", async () => {
    const calls = mockFetchJson({
      dataSets: [
        {
          series: {
            "0:0:0:0:0": {
              observations: { "0": ["1.0945"] },
            },
          },
        },
      ],
      structure: {
        dimensions: {
          observation: [{ values: [{ id: "2024-06-25" }] }],
        },
      },
    });
    const result = await getEcbFxRate("2024-06-25T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // primary + fallback
  });

  it("returns null when rate value is Infinity", async () => {
    const calls = mockFetchJson({
      dataSets: [
        {
          series: {
            "0:0:0:0:0": {
              observations: { "0": [Infinity] },
            },
          },
        },
      ],
      structure: {
        dimensions: {
          observation: [{ values: [{ id: "2024-06-26" }] }],
        },
      },
    });
    const result = await getEcbFxRate("2024-06-26T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // primary + fallback
  });

  it("returns null when rate value is NaN", async () => {
    const calls = mockFetchJson({
      dataSets: [
        {
          series: {
            "0:0:0:0:0": {
              observations: { "0": [NaN] },
            },
          },
        },
      ],
      structure: {
        dimensions: {
          observation: [{ values: [{ id: "2024-06-27" }] }],
        },
      },
    });
    const result = await getEcbFxRate("2024-06-27T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // primary + fallback
  });

  it("returns null when structure.dimensions.observation[0].values is missing AND fallback observations are also malformed", async () => {
    const malformedData = {
      dataSets: [
        {
          series: {
            "0:0:0:0:0": {
              observations: { "0": ["not a number"] }, // fallback will also fail on this
            },
          },
        },
      ],
      structure: {
        dimensions: {
          observation: [{ values: undefined }],
        },
      },
    };
    const calls = mockFetchJson(malformedData);
    const result = await getEcbFxRate("2024-06-28T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // primary + fallback (both return malformed)
  });
});

describe("getEcbFxRate — invalid/boundary dates and weekend fallback", () => {
  it("returns null and avoids fetch for empty string input", async () => {
    const calls = mockFetchJson({});
    const result = await getEcbFxRate("");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for garbage string (not a date)", async () => {
    const calls = mockFetchJson({});
    const result = await getEcbFxRate("not-a-date");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("uses date portion correctly from valid ISO timestamp with time component", async () => {
    const calls = mockFetchJson({
      dataSets: [
        {
          series: {
            "0:0:0:0:0": {
              observations: {
                "0": [1.0945, 0, 0, null, null],
              },
            },
          },
        },
      ],
      structure: {
        dimensions: {
          observation: [
            {
              values: [{ id: "2025-01-15" }],
            },
          ],
        },
      },
    });

    const result = await getEcbFxRate("2025-01-15T14:30:00.000Z");
    expect(result).toBe(1.0945);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("startPeriod=2025-01-15");
    expect(calls[0].url).toContain("endPeriod=2025-01-15");
  });

  it("returns null when future date primary fetch returns 0 observations and fallback also returns 0 observations", async () => {
    const calls: FetchCall[] = [];
    let callCount = 0;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      callCount++;

      // Both primary and fallback return empty observations
      return {
        ok: true,
        json: async () => ({
          dataSets: [
            {
              series: {
                "0:0:0:0:0": {
                  observations: {},
                },
              },
            },
          ],
          structure: {
            dimensions: {
              observation: [
                {
                  values: [],
                },
              ],
            },
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const result = await getEcbFxRate("2099-12-31T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("Saturday date: primary returns 0 observations, fallback returns Friday rate", async () => {
    const calls: FetchCall[] = [];
    let callCount = 0;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      callCount++;

      if (callCount === 1) {
        // Primary fetch for Saturday returns empty
        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {},
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [],
                  },
                ],
              },
            },
          }),
        } as Response;
      } else {
        // Fallback fetch returns Friday rate
        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {
                      "0": [1.0850, 0, 0, null, null],
                    },
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [{ id: "2025-01-10" }],
                  },
                ],
              },
            },
          }),
        } as Response;
      }
    }) as unknown as typeof fetch;

    // 2025-01-11 is a Saturday
    const result = await getEcbFxRate("2025-01-11T00:00:00.000Z");
    expect(result).toBe(1.0850);
    expect(calls).toHaveLength(2);
  });

  it("Sunday date: primary returns 0 observations, fallback returns Friday rate", async () => {
    const calls: FetchCall[] = [];
    let callCount = 0;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      callCount++;

      if (callCount === 1) {
        // Primary fetch for Sunday returns empty
        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {},
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [],
                  },
                ],
              },
            },
          }),
        } as Response;
      } else {
        // Fallback fetch returns Friday rate
        return {
          ok: true,
          json: async () => ({
            dataSets: [
              {
                series: {
                  "0:0:0:0:0": {
                    observations: {
                      "0": [1.0875, 0, 0, null, null],
                    },
                  },
                },
              },
            ],
            structure: {
              dimensions: {
                observation: [
                  {
                    values: [{ id: "2025-01-10" }],
                  },
                ],
              },
            },
          }),
        } as Response;
      }
    }) as unknown as typeof fetch;

    // 2025-01-12 is a Sunday
    const result = await getEcbFxRate("2025-01-12T00:00:00.000Z");
    expect(result).toBe(1.0875);
    expect(calls).toHaveLength(2);
  });

  it("ECB public holiday: primary returns 0 observations, fallback returns rate from previous business day", async () => {
     const calls: FetchCall[] = [];
     let callCount = 0;

     globalThis.fetch = (async (input: RequestInfo | URL) => {
       calls.push({ url: String(input) });
       callCount++;

       if (callCount === 1) {
         // Primary fetch for holiday returns empty
         return {
           ok: true,
           json: async () => ({
             dataSets: [
               {
                 series: {
                   "0:0:0:0:0": {
                     observations: {},
                   },
                 },
               },
             ],
             structure: {
               dimensions: {
                 observation: [
                   {
                     values: [],
                   },
                 ],
               },
             },
           }),
         } as Response;
       } else {
         // Fallback fetch returns previous business day rate
         return {
           ok: true,
           json: async () => ({
             dataSets: [
               {
                 series: {
                   "0:0:0:0:0": {
                     observations: {
                       "0": [1.0920, 0, 0, null, null],
                     },
                   },
                 },
               },
             ],
             structure: {
               dimensions: {
                 observation: [
                   {
                     values: [{ id: "2025-01-01" }],
                   },
                 ],
               },
             },
           }),
         } as Response;
       }
     }) as unknown as typeof fetch;

     // 2025-01-01 is New Year's Day (ECB holiday)
     const result = await getEcbFxRate("2025-01-01T00:00:00.000Z");
     expect(result).toBe(1.0920);
     expect(calls).toHaveLength(2);
   });
});

describe("getHyperliquidHistoricalUsdPrice — network failures and caching", () => {
  it("HTTP 429 returns null", async () => {
    const calls = mockFetchJson({ error: "rate limited" }, { status: 429 });
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(
      config,
      "HYPE",
      "2024-06-15T00:00:00.000Z",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("HTTP 500 returns null", async () => {
    const calls = mockFetchJson({ error: "server error" }, { status: 500 });
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(
      config,
      "HYPE",
      "2024-06-15T00:00:00.000Z",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("network throw (fetch rejects) returns null", async () => {
    const calls = mockFetchReject(new Error("network down"));
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(
      config,
      "HYPE",
      "2024-06-15T00:00:00.000Z",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("negative cache prevents re-fetch: call once (500 response), immediately call again with same symbol+date → total of exactly 1 HTTP call", async () => {
    setNow(0);
    const calls = mockFetchJson({ error: "server error" }, { status: 500 });
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const ts = "2024-06-15T00:00:00.000Z";

    const r1 = await getHyperliquidHistoricalUsdPrice(config, "HYPE", ts);
    expect(r1).toBeNull();
    expect(calls).toHaveLength(1);

    // Second call within 5 seconds should use negative cache
    setNow(4999);
    const r2 = await getHyperliquidHistoricalUsdPrice(config, "HYPE", ts);
    expect(r2).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("positive cache prevents re-fetch: call once (success, price returned), call again within 24h → total of exactly 1 HTTP call", async () => {
    setNow(0);
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return {
        ok: true,
        json: async () => [{ c: "42.5" }],
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const ts = "2024-06-15T00:00:00.000Z";

    const r1 = await getHyperliquidHistoricalUsdPrice(config, "HYPE", ts);
    expect(r1).toBe(42.5);
    expect(calls).toHaveLength(1);

    // Call again within 24 hours
    setNow(24 * 60 * 60 * 1000 - 1);
    const r2 = await getHyperliquidHistoricalUsdPrice(config, "HYPE", ts);
    expect(r2).toBe(42.5);
    expect(calls).toHaveLength(1);
  });

  it("different dates are not cached together: call with date A (success), call with date B (success) → 2 HTTP calls, each returns correct price for its date", async () => {
    let callCount = 0;
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input) });
      callCount++;
      // Return different prices based on call order
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => [{ c: "42.5" }],
        } as Response;
      } else {
        return {
          ok: true,
          json: async () => [{ c: "43.5" }],
        } as Response;
      }
    }) as unknown as typeof fetch;

    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };

    const r1 = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-06-15T00:00:00.000Z");
    expect(r1).toBe(42.5);
    expect(calls).toHaveLength(1);

    const r2 = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-06-16T00:00:00.000Z");
    expect(r2).toBe(43.5);
    expect(calls).toHaveLength(2);
  });

  it("different symbols are not cached together: call with symbol HYPE date X (success), call with symbol BTC date X (success) → 2 HTTP calls", async () => {
    let callCount = 0;
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input) });
      callCount++;
      // Return different prices based on call order
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => [{ c: "42.5" }],
        } as Response;
      } else {
        return {
          ok: true,
          json: async () => [{ c: "65000" }],
        } as Response;
      }
    }) as unknown as typeof fetch;

    const config = {
      pricing: {
        hyperliquidSymbols: { HYPE: "HYPE", BTC: "BTC" },
      },
    };
    const ts = "2024-06-15T00:00:00.000Z";

    const r1 = await getHyperliquidHistoricalUsdPrice(config, "HYPE", ts);
    expect(r1).toBe(42.5);
    expect(calls).toHaveLength(1);

    const r2 = await getHyperliquidHistoricalUsdPrice(config, "BTC", ts);
    expect(r2).toBe(65000);
    expect(calls).toHaveLength(2);
  });
});

describe("getHyperliquidHistoricalUsdPrice — malformed candle responses", () => {
  it("returns null when response is not an array (object)", async () => {
    const calls = mockFetchJson({});
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-01-01T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when response is not an array (null)", async () => {
    const calls = mockFetchJson(null);
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-01-02T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when response is not an array (string)", async () => {
    const calls = mockFetchJson("ok");
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-01-03T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when response is an empty array", async () => {
    const calls = mockFetchJson([]);
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-01-04T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when candle c field is missing", async () => {
    const calls = mockFetchJson([{ t: 123 }]);
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-01-05T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when candle c is zero string", async () => {
    const calls = mockFetchJson([{ c: "0" }]);
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-01-06T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when candle c is negative string", async () => {
    const calls = mockFetchJson([{ c: "-5.0" }]);
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-01-07T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when candle c is NaN string", async () => {
    const calls = mockFetchJson([{ c: "NaN" }]);
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-01-08T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when candle c is Infinity string", async () => {
    const calls = mockFetchJson([{ c: "Infinity" }]);
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-01-09T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when candle c is null", async () => {
    const calls = mockFetchJson([{ c: null }]);
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-01-10T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when candle c is a number (not a string)", async () => {
    const calls = mockFetchJson([{ c: 42.5 }]);
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-01-11T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns first candle close price when multiple candles returned", async () => {
    const calls = mockFetchJson([
      { c: "42.5" },
      { c: "50.0" },
      { c: "55.0" },
    ]);
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-01-12T00:00:00.000Z");
    expect(result).toBe(42.5);
    expect(calls).toHaveLength(1);
  });
});

describe("getHyperliquidHistoricalUsdPrice — unmapped symbols and bad timestamps", () => {
  it("returns null and avoids fetch when pricing config is missing", async () => {
    const calls = mockFetchJson([{ c: "37.42", t: 1705276800000 }]);
    const result = await getHyperliquidHistoricalUsdPrice({}, "HYPE", "2024-01-15T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch when hyperliquidSymbols mapping is missing", async () => {
    const calls = mockFetchJson([{ c: "37.42", t: 1705276800000 }]);
    const config = { pricing: { coingeckoIds: { HYPE: "hyperliquid" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-01-15T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch when symbol is not in hyperliquidSymbols", async () => {
    const calls = mockFetchJson([{ c: "37.42", t: 1705276800000 }]);
    const config = { pricing: { hyperliquidSymbols: { OTHER: "OTHER" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-01-15T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("resolves symbol case-insensitively: config has WHYPE: HYPE, call uses whype", async () => {
    const calls: FetchCall[] = [];
    let capturedBody: unknown;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input) });
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return {
        ok: true,
        json: async () => [{ c: "37.42", t: 1705276800000 }],
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { hyperliquidSymbols: { WHYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "whype", "2024-01-15T00:00:00.000Z");
    expect(result).toBe(37.42);
    expect(calls).toHaveLength(1);
    expect(capturedBody).toEqual({
      type: "candleSnapshot",
      req: {
        coin: "HYPE",
        interval: "1d",
        startTime: 1705276800000,
        endTime: 1705363199999,
      },
    });
  });

  it("returns null and avoids fetch for empty string symbol", async () => {
    const calls = mockFetchJson([{ c: "37.42", t: 1705276800000 }]);
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "", "2024-01-15T00:00:00.000Z");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for empty string isoTimestamp", async () => {
    const calls = mockFetchJson([{ c: "37.42", t: 1705276800000 }]);
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and avoids fetch for garbage isoTimestamp (not a date)", async () => {
    const calls = mockFetchJson([{ c: "37.42", t: 1705276800000 }]);
    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "not-a-date");
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("valid ISO timestamp with time component: date portion used correctly, startTime/endTime bracket full UTC day", async () => {
    const calls: FetchCall[] = [];
    let capturedBody: unknown;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input) });
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return {
        ok: true,
        json: async () => [{ c: "42.99", t: 1705276800000 }],
      } as Response;
    }) as unknown as typeof fetch;

    const config = { pricing: { hyperliquidSymbols: { HYPE: "HYPE" } } };
    // 2024-01-15T14:30:45.123Z — should use 2024-01-15 date portion
    const result = await getHyperliquidHistoricalUsdPrice(config, "HYPE", "2024-01-15T14:30:45.123Z");
    expect(result).toBe(42.99);
    expect(calls).toHaveLength(1);

    // Verify POST body has correct startTime (00:00:00.000 UTC) and endTime (23:59:59.999 UTC)
    expect(capturedBody).toEqual({
      type: "candleSnapshot",
      req: {
        coin: "HYPE",
        interval: "1d",
        startTime: 1705276800000, // 2024-01-15 00:00:00 UTC
        endTime: 1705363199999,   // 2024-01-15 23:59:59.999 UTC
      },
    });
  });
});
