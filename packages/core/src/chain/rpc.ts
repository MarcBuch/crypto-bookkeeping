/**
 * Rate limiting and retry utilities for HyperEVM RPC.
 *
 * Pacing is per-endpoint: each URL has its own minimum interval (milliseconds)
 * configured by the caller. This lets a slow public full node and a fast
 * HyperRPC-compatible endpoint coexist without one throttling the other. The
 * interval is kept low but non-zero to avoid hammering an endpoint.
 */

import { RpcError } from "../services/errors.js";

// Per-URL state: the last time a request was sent, and the tail of the promise
// chain that serializes concurrent callers so they queue up rather than all
// reading the timestamp before any of them updates it.
const lastRequestTimes = new Map<string, number>();
const rateLimitPromises = new Map<string, Promise<void>>();

export async function rateLimit(url: string, minIntervalMs: number): Promise<void> {
  // Chain onto the previous rate-limit promise for this URL so concurrent
  // callers queue up rather than all firing simultaneously.
  const previous = rateLimitPromises.get(url) ?? Promise.resolve();
  const next = previous.then(async () => {
    const elapsed = Date.now() - (lastRequestTimes.get(url) ?? 0);
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed);
    }
    lastRequestTimes.set(url, Date.now());
  });
  rateLimitPromises.set(url, next);
  return next;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff on rate limit errors.
 *
 * Pacing between requests is handled by the transport layer (see
 * `rateLimit`); this function only decides whether and how long to back off
 * after a failed attempt. When a rate-limit error carries `retryAfterMs`
 * (parsed from an HTTP `Retry-After` header), it is used as the minimum delay
 * for that retry, still capped by `maxDelay`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 8,
  baseDelay = 1000,
  maxDelay = 30_000,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isRateLimit =
        error?.code === -32005 ||
        error?.details?.includes("rate limited") ||
        error?.shortMessage?.includes("rate limit") ||
        error?.cause?.code === -32005;

      if (isRateLimit && attempt < maxRetries) {
        const backoff = Math.min(baseDelay * 2 ** attempt, maxDelay);
        const retryAfterMs =
          typeof error?.retryAfterMs === "number" && error.retryAfterMs > 0
            ? error.retryAfterMs
            : 0;
        const delay = Math.min(Math.max(backoff, retryAfterMs), maxDelay);
        console.warn(
          `  Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`,
        );
        await sleep(delay);
        continue;
      }
      // Normalize viem rate-limit errors to our RpcError so callers can
      // reliably detect them with instanceof + code checks.
      if (isRateLimit) {
        throw new RpcError("RPC rate limited", -32005);
      }
      throw error;
    }
  }
  throw new Error("Max retries exceeded");
}
