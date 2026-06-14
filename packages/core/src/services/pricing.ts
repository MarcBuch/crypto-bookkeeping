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
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const ECB_EXCHANGE_RATE_URL = "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A";
const ECB_SERIES_KEY = "0:0:0:0:0";
const PRICE_CACHE_TTL_MS = 60_000;
const NEGATIVE_CACHE_TTL_MS = 5_000;
const HISTORICAL_PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type PriceCacheEntry = {
  price: number | null;
  expiresAt: number;
};

const priceCache = new Map<string, PriceCacheEntry>();
const historicalPriceCache = new Map<string, PriceCacheEntry>();

// For testing only: clear all caches
export function __clearCaches(): void {
  priceCache.clear();
  historicalPriceCache.clear();
}

/** Symbols that are always treated as exactly 1.00 USD without a CoinGecko call. */
const USD_STABLECOIN_SYMBOLS = new Set(["USDC", "USDT", "DAI", "USDE", "FRAX", "PYUSD"]);

function isUsdStablecoin(token: PricingToken): boolean {
  const sym = typeof token === "string" ? token : token.symbol;
  return sym != null && USD_STABLECOIN_SYMBOLS.has(sym.toUpperCase());
}

export async function getUsdPrices(
  config: Pick<Config, "pricing">,
  tokens: PricingToken[],
): Promise<UsdPriceMap> {
  const idsByResultKey = new Map<string, string>();
  const result: UsdPriceMap = {};

  for (const token of tokens) {
    const key = tokenKey(token);
    if (!key) continue;

    // Short-circuit well-known USD stablecoins to avoid an unnecessary CoinGecko call
    if (isUsdStablecoin(token)) {
      result[key] = 1.0;
      continue;
    }

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

function resolveHyperliquidSymbol(config: Pick<Config, "pricing">, token: string): string | null {
  const symbols = config.pricing?.hyperliquidSymbols;
  if (!symbols) return null;

  const candidates = [token, token.toLowerCase(), token.toUpperCase()];

  for (const candidate of candidates) {
    if (candidate && symbols[candidate]) return symbols[candidate];
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

function cacheHistorical(key: string, price: number | null, ttlMs: number): void {
  historicalPriceCache.set(key, { price, expiresAt: Date.now() + ttlMs });
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

function isoToYyyyMmDd(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) throw new Error("Invalid timestamp");
  const year = String(d.getUTCFullYear());
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function getHistoricalPrice(
  config: Pick<Config, "pricing">,
  symbol: string,
  isoTimestamp: string,
  currency: "eur" | "usd",
): Promise<number | null> {
  // Short-circuit USD stablecoins: their USD price is always 1.0.
  // For EUR, derive from the ECB rate (1 USDC = 1 USD = 1/ecbRate EUR).
  if (isUsdStablecoin(symbol)) {
    if (currency === "usd") return 1.0;
    const ecbRate = await getEcbFxRate(isoTimestamp);
    return ecbRate !== null ? 1.0 / ecbRate : null;
  }

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

  // For EUR: try composed path (Hyperliquid USD price / ECB FX rate) first
  if (currency === "eur") {
    const [hlUsdPrice, ecbRate] = await Promise.all([
      getHyperliquidHistoricalUsdPrice(config, symbol, isoTimestamp),
      getEcbFxRate(isoTimestamp),
    ]);

    if (hlUsdPrice !== null && ecbRate !== null) {
      const eurPrice = hlUsdPrice / ecbRate;
      if (Number.isFinite(eurPrice) && eurPrice > 0) {
        cacheHistorical(cacheKey, eurPrice, HISTORICAL_PRICE_CACHE_TTL_MS);
        return eurPrice;
      }
    }
  }

  // Fallback to CoinGecko for both EUR and USD
  try {
    const url = `${COINGECKO_HISTORY_URL}/${coinGeckoId}/history?date=${dateStr}&localization=false`;
    const response = await fetch(url);
    if (!response.ok) {
      cacheHistorical(cacheKey, null, NEGATIVE_CACHE_TTL_MS);
      return null;
    }

    const data = await response.json();
    const marketData = (data as Record<string, unknown>)?.["market_data"] as
      | Record<string, unknown>
      | undefined;
    const currentPrice = marketData?.["current_price"] as Record<string, unknown> | undefined;
    const price = currentPrice?.[currency];

    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      cacheHistorical(cacheKey, null, NEGATIVE_CACHE_TTL_MS);
      return null;
    }

    cacheHistorical(cacheKey, price, HISTORICAL_PRICE_CACHE_TTL_MS);
    return price;
  } catch {
    cacheHistorical(cacheKey, null, NEGATIVE_CACHE_TTL_MS);
    return null;
  }
}

/**
 * Returns the ECB reference exchange rate for the given date: how many USD equal 1 EUR
 * (e.g. 1.0945 means 1 EUR = 1.0945 USD). Source: ECB series D.USD.EUR.SP00.A.
 *
 * If the requested date has no fix (weekend, public holiday, or future date), falls back
 * to the most recent prior business day rate via a second request.
 *
 * To convert a USD price to EUR: price_eur = price_usd / getEcbFxRate(date)
 */
export async function getEcbFxRate(isoDate: string): Promise<number | null> {
  let dateStr: string;
  try {
    dateStr = isoToYyyyMmDd(isoDate);
  } catch {
    return null;
  }

  const cacheKey = `ecb:${dateStr}`;
  const cached = getCachedHistoricalPrice(cacheKey);
  if (cached !== undefined) return cached;

  try {
    // Primary fetch: try to get the exact date
    const primaryUrl = `${ECB_EXCHANGE_RATE_URL}?startPeriod=${dateStr}&endPeriod=${dateStr}&format=jsondata`;
    const primaryResponse = await fetch(primaryUrl);
    if (!primaryResponse.ok) {
      cacheHistorical(cacheKey, null, NEGATIVE_CACHE_TTL_MS);
      return null;
    }

    const primaryData = await primaryResponse.json();
    const rate = extractEcbRate(primaryData, dateStr);

    if (rate !== null) {
      cacheHistorical(cacheKey, rate, HISTORICAL_PRICE_CACHE_TTL_MS);
      return rate;
    }

    // Fallback: get the last observation before or on the requested date
    const fallbackUrl = `${ECB_EXCHANGE_RATE_URL}?lastNObservations=1&endPeriod=${dateStr}&format=jsondata`;
    const fallbackResponse = await fetch(fallbackUrl);
    if (!fallbackResponse.ok) {
      cacheHistorical(cacheKey, null, NEGATIVE_CACHE_TTL_MS);
      return null;
    }

    const fallbackData = await fallbackResponse.json();
    const fallbackRate = extractEcbRateFromFallback(fallbackData);

    if (fallbackRate !== null) {
      cacheHistorical(cacheKey, fallbackRate, HISTORICAL_PRICE_CACHE_TTL_MS);
      return fallbackRate;
    }

    cacheHistorical(cacheKey, null, NEGATIVE_CACHE_TTL_MS);
    return null;
  } catch {
    cacheHistorical(cacheKey, null, NEGATIVE_CACHE_TTL_MS);
    return null;
  }
}

function extractEcbObservations(data: unknown): Record<string, unknown> | null {
  try {
    const obj = data as Record<string, unknown>;
    const dataSets = obj.dataSets as unknown[];
    if (!Array.isArray(dataSets) || dataSets.length === 0) return null;
    const dataSet = dataSets[0] as Record<string, unknown>;
    const series = dataSet.series as Record<string, unknown>;
    if (!series) return null;
    const seriesData = series[ECB_SERIES_KEY] as Record<string, unknown>;
    if (!seriesData) return null;
    const observations = seriesData.observations as Record<string, unknown>;
    if (!observations) return null;
    return observations;
  } catch {
    return null;
  }
}

function extractEcbRate(data: unknown, dateStr: string): number | null {
  try {
    const observations = extractEcbObservations(data);
    if (!observations) return null;

    const obj = data as Record<string, unknown>;
    const structure = obj.structure as Record<string, unknown>;
    if (!structure) return null;
    const dimensions = structure.dimensions as Record<string, unknown>;
    if (!dimensions) return null;
    const observationDim = dimensions.observation as unknown[];
    if (!Array.isArray(observationDim) || observationDim.length === 0) return null;
    const observationValues = (observationDim[0] as Record<string, unknown>).values as unknown[];
    if (!Array.isArray(observationValues)) return null;

    let targetIndex = -1;
    for (let i = 0; i < observationValues.length; i++) {
      const val = observationValues[i] as Record<string, unknown>;
      if (val.id === dateStr) { targetIndex = i; break; }
    }
    if (targetIndex === -1) return null;

    const observationArray = observations[String(targetIndex)] as unknown[];
    if (!Array.isArray(observationArray) || observationArray.length === 0) return null;
    const rate = observationArray[0];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
    return rate;
  } catch {
    return null;
  }
}

function extractEcbRateFromFallback(data: unknown): number | null {
  try {
    const observations = extractEcbObservations(data);
    if (!observations) return null;
    // lastNObservations=1 guarantees exactly one observation, always at index "0"
    const observationArray = observations["0"] as unknown[];
    if (!Array.isArray(observationArray) || observationArray.length === 0) return null;
    const rate = observationArray[0];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
    return rate;
  } catch {
    return null;
  }
}

/**
 * Returns the historical close price of a token in USD for the given date,
 * sourced from Hyperliquid's candleSnapshot API.
 *
 * @param config - Must include `pricing.hyperliquidSymbols` mapping (e.g. { WHYPE: "HYPE" }).
 * @param symbol - User-facing token symbol (e.g. "WHYPE"), NOT the Hyperliquid internal name.
 *                 Resolution is case-insensitive and uses the hyperliquidSymbols config map.
 * @param isoTimestamp - ISO 8601 date or datetime string; only the UTC date portion is used.
 * @returns The USD close price for the day, or null if unavailable.
 */
export async function getHyperliquidHistoricalUsdPrice(
  config: Pick<Config, "pricing">,
  symbol: string,
  isoTimestamp: string,
): Promise<number | null> {
  const hlSymbol = resolveHyperliquidSymbol(config, symbol);
  if (!hlSymbol) return null;

  let dateStr: string;
  try {
    dateStr = isoToYyyyMmDd(isoTimestamp);
  } catch {
    return null;
  }

  const cacheKey = `hl:${hlSymbol}:${dateStr}`;
  const cached = getCachedHistoricalPrice(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const date = new Date(isoTimestamp);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const day = date.getUTCDate();

    const startTime = Date.UTC(year, month, day, 0, 0, 0, 0);
    const endTime = Date.UTC(year, month, day, 23, 59, 59, 999);

    const response = await fetch(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: {
          coin: hlSymbol,
          interval: "1d",
          startTime,
          endTime,
        },
      }),
    });

    if (!response.ok) {
      historicalPriceCache.set(cacheKey, {
        price: null,
        expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
      });
      return null;
    }

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
      historicalPriceCache.set(cacheKey, {
        price: null,
        expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
      });
      return null;
    }

    const candle = data[0] as Record<string, unknown>;
    const closePrice = candle["c"];

    if (typeof closePrice !== "string") {
      cacheHistorical(cacheKey, null, NEGATIVE_CACHE_TTL_MS);
      return null;
    }

    const price = Number(closePrice);
    if (!Number.isFinite(price) || price <= 0) {
      cacheHistorical(cacheKey, null, NEGATIVE_CACHE_TTL_MS);
      return null;
    }

    cacheHistorical(cacheKey, price, HISTORICAL_PRICE_CACHE_TTL_MS);
    return price;
  } catch {
    cacheHistorical(cacheKey, null, NEGATIVE_CACHE_TTL_MS);
    return null;
  }
}
