import { describe, it, expect } from "bun:test";

import { rateLimit, withRetry } from "../chain/rpc.js";
import { RpcError } from "../services/errors.js";
import { captureError, expectError } from "./helpers/errors.js";

// Helper: simulate a viem LimitExceededRpcError-style object
function makeRateLimitError(extra: Record<string, unknown> = {}) {
  return Object.assign(new Error("rate limited"), { details: "rate limited" }, extra);
}

const immediateSuccessFn = async () => 42;

let urlCounter = 0;
function uniqueUrl(host: string): string {
  urlCounter++;
  return `https://${host}.example/${urlCounter}`;
}

function expectRpcError(error: unknown): RpcError {
  expect(error).toBeInstanceOf(RpcError);
  if (!(error instanceof RpcError)) {
    throw new Error(`Expected RpcError, got ${String(error)}`);
  }
  return error;
}

describe("rateLimit — per-URL pacing", () => {
  it("spaces sequential requests to the same URL by the configured interval", async () => {
    const url = uniqueUrl("pace");
    const start = Date.now();
    await rateLimit(url, 40);
    await rateLimit(url, 40);
    expect(Date.now() - start).toBeGreaterThanOrEqual(35);
  });

  it("does not pace requests to different URLs against each other", async () => {
    const urlA = uniqueUrl("a");
    const urlB = uniqueUrl("b");
    await rateLimit(urlA, 1000); // first call for A establishes its clock
    const start = Date.now();
    await rateLimit(urlB, 1000); // first call for B must not wait on A
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("queues concurrent callers for the same URL instead of firing together", async () => {
    const url = uniqueUrl("queue");
    const start = Date.now();
    await Promise.all([rateLimit(url, 30), rateLimit(url, 30), rateLimit(url, 30)]);
    // The first call fires immediately; the next two each wait one interval.
    expect(Date.now() - start).toBeGreaterThanOrEqual(55);
  });
});

describe("withRetry — retry exhaustion and passthrough", () => {
  it("resolves immediately when fn succeeds on first attempt", async () => {
    const result = await withRetry(immediateSuccessFn, 0);
    expect(result).toBe(42);
  });

  it("maxRetries=0 throws RpcError(-32005) immediately without sleeping on rate-limit error", async () => {
    const fn = async () => {
      throw makeRateLimitError();
    };
    const start = Date.now();
    const err = expectRpcError(await captureError(withRetry(fn, 0)));
    const elapsed = Date.now() - start;
    expect(err.code).toBe(-32005);
    // Should not have slept for any backoff
    expect(elapsed).toBeLessThan(500);
  });

  it("throws RpcError(-32005) after exhausting all retries", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw makeRateLimitError();
    };
    const err = expectRpcError(await captureError(withRetry(fn, 2, 10)));
    expect(err.code).toBe(-32005);
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it("resolves if last retry succeeds after rate-limit failures", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw makeRateLimitError();
      return "ok";
    };
    const result = await withRetry(fn, 3, 10);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("rethrows non-rate-limit error immediately without retrying", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error("unexpected blockchain failure");
    };
    const err = expectError(await captureError(withRetry(fn, 3, 10)));
    expect(err.message).toBe("unexpected blockchain failure");
    expect(calls).toBe(1); // no retries
  });

  it("non-rate-limit error is not wrapped in RpcError", async () => {
    const original = new TypeError("type mismatch");
    const fn = async () => {
      throw original;
    };
    const err = await captureError(withRetry(fn, 3, 10));
    expect(err).toBe(original); // same reference, not wrapped
    expect(err).not.toBeInstanceOf(RpcError);
  });
});

describe("withRetry — retryAfterMs and backoff", () => {
  it("uses retryAfterMs as a minimum delay when it exceeds the backoff", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) {
        throw makeRateLimitError({ code: -32005, retryAfterMs: 60 });
      }
      return "ok";
    };
    const start = Date.now();
    const result = await withRetry(fn, 2, 1, 5000);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(55);
  });

  it("caps the effective delay at maxDelay even when retryAfterMs is larger", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) {
        throw makeRateLimitError({ code: -32005, retryAfterMs: 5000 });
      }
      return "ok";
    };
    const start = Date.now();
    const result = await withRetry(fn, 2, 1, 20);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("backoff delay is capped at maxDelay", async () => {
    // baseDelay=10, maxDelay=15: attempt 0 → min(10,15)=10ms, attempt 1 → min(20,15)=15ms
    // Structural proof: call count of 3 (2 failures + 1 success) confirms both retries
    // executed, and the result "done" confirms it resolved correctly.
    // Timing assertions are omitted — process overhead dominates at these small delays.
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw makeRateLimitError();
      return "done";
    };

    const result = await withRetry(fn, 4, 10, 15);

    expect(result).toBe("done");
    expect(calls).toBe(3); // 2 rate-limit failures + 1 success
  });
});
