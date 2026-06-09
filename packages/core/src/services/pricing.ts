import type { Address } from "viem";

import type { Config } from "../config.js";

export type PricingToken =
  | string
  | {
      symbol?: string;
      address?: Address | string;
    };

export type UsdPriceMap = Record<string, number | null>;

const COINGECKO_SIMPLE_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price";
const COINGECKO_HISTORY_URL = "https://api.coingecko.com/api/v3/coins";
const PRICE_CACHE_TTL_MS = 60_000;
const NEGATIVE_CACHE_TTL_MS = 5_000;
const HISTORICAL_PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type PriceCacheEntry = {
  price: number | null;
  expiresAt: number;
};

const priceCache = new Map<string, PriceCacheEntry>();
const historicalPriceCache = new Map<string, PriceCacheEntry>();

export async function getUsdPrices(
  config: Pick<Config, "pricing">,
  tokens: PricingToken[],
): Promise<UsdPriceMap> {
  const idsByResultKey = new Map<string, string>();
  const result: UsdPriceMap = {};

  for (const token of tokens) {
    const key = tokenKey(token);
    if (!key) continue;

    result[key] = null;

    const coinGeckoId = resolveCoinGeckoId(config, token);
    if (coinGeckoId) {
      idsByResultKey.set(key, coinGeckoId);
    }
  }

  const idsToFetch = [
    ...new Set([...idsByResultKey.values()].filter((id) => getCachedPrice(id) === undefined)),
  ];
  if (idsToFetch.length > 0) {
    await fetchAndCachePrices(idsToFetch);
  }

  for (const [key, coinGeckoId] of idsByResultKey) {
    result[key] = getCachedPrice(coinGeckoId) ?? null;
  }

  return result;
}

function tokenKey(token: PricingToken): string {
  if (typeof token === "string") return token;
  return token.address?.toLowerCase() ?? token.symbol ?? "";
}

function getCachedPrice(coinGeckoId: string): number | null | undefined {
  const cached = priceCache.get(coinGeckoId);
  if (!cached) return undefined;

  if (cached.expiresAt <= Date.now()) {
    priceCache.delete(coinGeckoId);
    return undefined;
  }

  return cached.price;
}

function resolveCoinGeckoId(config: Pick<Config, "pricing">, token: PricingToken): string | null {
  const ids = config.pricing?.coingeckoIds;
  if (!ids) return null;

  const candidates =
    typeof token === "string"
      ? [token, token.toLowerCase(), token.toUpperCase()]
      : [
          token.address,
          token.address?.toLowerCase(),
          token.symbol,
          token.symbol?.toLowerCase(),
          token.symbol?.toUpperCase(),
        ];

  for (const candidate of candidates) {
    if (candidate && ids[candidate]) return ids[candidate];
  }

  return null;
}

async function fetchAndCachePrices(coinGeckoIds: string[]): Promise<void> {
  try {
    const params = new URLSearchParams({
      ids: coinGeckoIds.join(","),
      vs_currencies: "usd",
    });
    const response = await fetch(`${COINGECKO_SIMPLE_PRICE_URL}?${params.toString()}`);
    if (!response.ok) {
      cacheUnavailable(coinGeckoIds);
      return;
    }

    const data = await response.json();
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      cacheUnavailable(coinGeckoIds);
      return;
    }

    for (const coinGeckoId of coinGeckoIds) {
      const responsePrice = (data as Record<string, unknown>)[coinGeckoId];
      const usd =
        typeof responsePrice === "object" && responsePrice !== null
          ? (responsePrice as Record<string, unknown>).usd
          : undefined;
      const price = typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? usd : null;
      cachePrice(coinGeckoId, price, price === null ? NEGATIVE_CACHE_TTL_MS : PRICE_CACHE_TTL_MS);
    }
  } catch {
    cacheUnavailable(coinGeckoIds);
  }
}

function cachePrice(coinGeckoId: string, price: number | null, ttlMs: number): void {
  priceCache.set(coinGeckoId, {
    price,
    expiresAt: Date.now() + ttlMs,
  });
}

function cacheUnavailable(coinGeckoIds: string[]): void {
  for (const coinGeckoId of coinGeckoIds) {
    cachePrice(coinGeckoId, null, NEGATIVE_CACHE_TTL_MS);
  }
}

function getCachedHistoricalPrice(cacheKey: string): number | null | undefined {
  const cached = historicalPriceCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    historicalPriceCache.delete(cacheKey);
    return undefined;
  }
  return cached.price;
}

function isoToddmmyyyy(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) throw new Error("Invalid timestamp");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = String(d.getUTCFullYear());
  return `${day}-${month}-${year}`;
}

export async function getHistoricalPrice(
  config: Pick<Config, "pricing">,
  symbol: string,
  isoTimestamp: string,
  currency: "eur" | "usd",
): Promise<number | null> {
  const coinGeckoId = resolveCoinGeckoId(config, symbol);
  if (!coinGeckoId) return null;

  let dateStr: string;
  try {
    dateStr = isoToddmmyyyy(isoTimestamp);
  } catch {
    return null;
  }

  const cacheKey = `${currency}:${coinGeckoId}:${dateStr}`;
  const cached = getCachedHistoricalPrice(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const url = `${COINGECKO_HISTORY_URL}/${coinGeckoId}/history?date=${dateStr}&localization=false`;
    const response = await fetch(url);
    if (!response.ok) {
      historicalPriceCache.set(cacheKey, {
        price: null,
        expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
      });
      return null;
    }

    const data = await response.json();
    const marketData = (data as Record<string, unknown>)?.["market_data"] as
      | Record<string, unknown>
      | undefined;
    const currentPrice = marketData?.["current_price"] as Record<string, unknown> | undefined;
    const price = currentPrice?.[currency];

    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
      historicalPriceCache.set(cacheKey, {
        price: null,
        expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
      });
      return null;
    }

    historicalPriceCache.set(cacheKey, {
      price,
      expiresAt: Date.now() + HISTORICAL_PRICE_CACHE_TTL_MS,
    });
    return price;
  } catch {
    historicalPriceCache.set(cacheKey, {
      price: null,
      expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
    });
    return null;
  }
}
