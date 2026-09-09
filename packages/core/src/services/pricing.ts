import type { Address } from "viem";

import type { Config } from "../config.js";
import { isRecord } from "../utils/guards.js";

export type PricingToken =
  | string
  | {
      symbol?: string;
      address?: Address;
    };

export type UsdPriceMap = Record<string, number | null>;

const COINGECKO_SIMPLE_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price";
const COINGECKO_HISTORY_URL = "https://api.coingecko.com/api/v3/coins";
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const PRICE_CACHE_TTL_MS = 60_000;
const NEGATIVE_CACHE_TTL_MS = 5_000;
const HISTORICAL_PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type PriceCacheEntry = {
  price: number | null;
  expiresAt: number;
};

export type HistoricalPriceSource = "coingecko" | "hyperliquid-candle" | "stablecoin-peg";
export interface HistoricalPriceResult {
  price: number | null;
  source: HistoricalPriceSource | null;
  /** Timestamp of the selected market observation. */
  observedAt: string | null;
}

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

  const missingFallbackIds = [
    ...new Set(
      [...idsByResultKey.entries()]
        .filter(([key]) => result[key] === null)
        .map(([, coinGeckoId]) => coinGeckoId)
        .filter((coinGeckoId) => hyperliquidCoin(coinGeckoId) !== null),
    ),
  ];
  if (missingFallbackIds.length > 0) {
    const fallbackPrices = await fetchHyperliquidUsdPrices(missingFallbackIds);
    for (const [key, coinGeckoId] of idsByResultKey) {
      result[key] ??= fallbackPrices[coinGeckoId] ?? null;
    }
  }

  return result;
}

function hyperliquidCoin(coinGeckoId: string): string | null {
  if (coinGeckoId === "hyperliquid") return "HYPE";
  if (coinGeckoId === "bitcoin") return "BTC";
  return null;
}

async function fetchHyperliquidUsdPrices(coinGeckoIds: string[]): Promise<UsdPriceMap> {
  const result: UsdPriceMap = {};
  try {
    const response = await fetch(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
    });
    if (!response.ok) return result;

    const data = await response.json();
    if (!isRecord(data)) return result;

    for (const coinGeckoId of coinGeckoIds) {
      const coin = hyperliquidCoin(coinGeckoId);
      const rawPrice = coin ? data[coin] : undefined;
      const price = typeof rawPrice === "string" ? Number(rawPrice) : rawPrice;
      if (typeof price === "number" && Number.isFinite(price) && price > 0) {
        result[coinGeckoId] = price;
      }
    }
  } catch {
    // USD pricing is optional; preserve the existing null result on failure.
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
    if (!isRecord(data)) {
      cacheUnavailable(coinGeckoIds);
      return;
    }

    for (const coinGeckoId of coinGeckoIds) {
      const responsePrice = data[coinGeckoId];
      const usd = isRecord(responsePrice) ? responsePrice.usd : undefined;
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
  return (await getHistoricalPriceResult(config, symbol, isoTimestamp, currency)).price;
}

export async function getHistoricalPriceResult(
  config: Pick<Config, "pricing">,
  symbol: string,
  isoTimestamp: string,
  currency: "eur" | "usd",
): Promise<HistoricalPriceResult> {
  const coinGeckoId = resolveCoinGeckoId(config, symbol);
  if (!coinGeckoId) return { price: null, source: null, observedAt: null };

  const requestedAt = new Date(isoTimestamp);
  if (isNaN(requestedAt.getTime())) return { price: null, source: null, observedAt: null };
  if (currency === "usd" && coinGeckoId === "usd-coin") {
    return { price: 1, source: "stablecoin-peg", observedAt: isoTimestamp };
  }

  let dateStr: string;
  try {
    dateStr = isoToddmmyyyy(isoTimestamp);
  } catch {
    return { price: null, source: null, observedAt: null };
  }

  const cacheKey = `${currency}:${coinGeckoId}:${dateStr}`;
  const cached = getCachedHistoricalPrice(cacheKey);
  if (cached !== undefined) {
    return { price: cached, source: cached === null ? null : "coingecko", observedAt: null };
  }

  try {
    const url = `${COINGECKO_HISTORY_URL}/${coinGeckoId}/history?date=${dateStr}&localization=false`;
    const response = await fetch(url);
    if (!response.ok) {
      historicalPriceCache.set(cacheKey, {
        price: null,
        expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
      });
      return await historicalFallback(coinGeckoId, requestedAt, currency, cacheKey);
    }

    const data = await response.json();
    const marketData = isRecord(data) && isRecord(data.market_data) ? data.market_data : undefined;
    const currentPrice =
      marketData !== undefined && isRecord(marketData.current_price)
        ? marketData.current_price
        : undefined;
    const price = currentPrice?.[currency];

    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
      historicalPriceCache.set(cacheKey, {
        price: null,
        expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
      });
      return await historicalFallback(coinGeckoId, requestedAt, currency, cacheKey);
    }

    historicalPriceCache.set(cacheKey, {
      price,
      expiresAt: Date.now() + HISTORICAL_PRICE_CACHE_TTL_MS,
    });
    return { price, source: "coingecko", observedAt: isoTimestamp };
  } catch {
    return await historicalFallback(coinGeckoId, requestedAt, currency, cacheKey);
  }
}

async function historicalFallback(
  coinGeckoId: string,
  requestedAt: Date,
  currency: "eur" | "usd",
  cacheKey: string,
): Promise<HistoricalPriceResult> {
  const coin = currency === "usd" ? hyperliquidCoin(coinGeckoId) : null;
  if (!coin) {
    historicalPriceCache.set(cacheKey, { price: null, expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS });
    return { price: null, source: null, observedAt: null };
  }
  try {
    const target = requestedAt.getTime();
    const response = await fetch(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: { coin, interval: "1h", startTime: target - 12 * 60 * 60 * 1000, endTime: target + 12 * 60 * 60 * 1000 },
      }),
    });
    const data: unknown = response.ok ? await response.json() : null;
    if (Array.isArray(data)) {
      const candidates = data.flatMap((item) => {
        if (!isRecord(item)) return [];
        const time = typeof item.t === "number" ? item.t : Number(item.t);
        const close = typeof item.c === "number" ? item.c : Number(item.c);
        return Number.isFinite(time) && Number.isFinite(close) && close > 0 ? [{ time, close }] : [];
      });
      const nearest = candidates.sort((a, b) => Math.abs(a.time - target) - Math.abs(b.time - target))[0];
      if (nearest) {
        historicalPriceCache.set(cacheKey, { price: nearest.close, expiresAt: Date.now() + HISTORICAL_PRICE_CACHE_TTL_MS });
        return { price: nearest.close, source: "hyperliquid-candle", observedAt: new Date(nearest.time).toISOString() };
      }
    }
  } catch {
    // Historical pricing is optional.
  }
  historicalPriceCache.set(cacheKey, { price: null, expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS });
  return { price: null, source: null, observedAt: null };
}
