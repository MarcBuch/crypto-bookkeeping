/**
 * Rate limiting and retry utilities for HyperEVM RPC.
 *
 * Using Envio HyperRPC (https://hyperliquid.rpc.hypersync.xyz) which has
 * much more relaxed rate limits than the public Hyperliquid RPC. The delay
 * is kept low but non-zero to avoid hammering the endpoint.
 */

import { RpcError } from "../services/errors.js";

const MIN_DELAY_MS = 10; // HyperRPC is far more permissive than the public RPC
let lastRequestTime = 0;
// Mutex flag to prevent the race condition where concurrent callers all read
// lastRequestTime before any of them update it.
let rateLimitPromise: Promise<void> = Promise.resolve();

export async function rateLimit(): Promise<void> {
  // Chain onto the previous rate-limit promise so concurrent callers queue up
  // rather than all firing simultaneously.
  rateLimitPromise = rateLimitPromise.then(async () => {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_DELAY_MS) {
      await sleep(MIN_DELAY_MS - elapsed);
    }
    lastRequestTime = Date.now();
    return undefined;
  });
  return rateLimitPromise;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff on rate limit errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 8,
  baseDelay = 1000,
  maxDelay = 30_000,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await rateLimit();
      return await fn();
    } catch (error: any) {
      const isRateLimit =
        error?.code === -32005 ||
        error?.details?.includes("rate limited") ||
        error?.shortMessage?.includes("rate limit") ||
        error?.cause?.code === -32005;

      if (isRateLimit && attempt < maxRetries) {
        const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
        console.warn(
          `  Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`,
        );
        lastRequestTime = Date.now() + delay;
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
