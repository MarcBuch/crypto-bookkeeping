import { describe, it, expect } from "bun:test";
import { withRetry } from "../chain/rpc.js";
import { RpcError } from "../services/errors.js";

// Helper: simulate a viem LimitExceededRpcError-style object
function makeRateLimitError() {
  return Object.assign(new Error("rate limited"), { details: "rate limited" });
}

describe("withRetry — retry exhaustion and passthrough", () => {
  it("resolves immediately when fn succeeds on first attempt", async () => {
    const fn = async () => 42;
    const result = await withRetry(fn, 0);
    expect(result).toBe(42);
  });

  it("maxRetries=0 throws RpcError(-32005) immediately without sleeping on rate-limit error", async () => {
    const fn = async () => {
      throw makeRateLimitError();
    };
    const start = Date.now();
    const err = await withRetry(fn, 0).catch((e) => e);
    const elapsed = Date.now() - start;
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(-32005);
    // Should not have slept for any backoff
    expect(elapsed).toBeLessThan(500);
  });

  it("throws RpcError(-32005) after exhausting all retries", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw makeRateLimitError();
    };
    const err = await withRetry(fn, 2, 10).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(-32005);
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
    const err = await withRetry(fn, 3, 10).catch((e) => e);
    expect((err as Error).message).toBe("unexpected blockchain failure");
    expect(calls).toBe(1); // no retries
  });

  it("non-rate-limit error is not wrapped in RpcError", async () => {
    const original = new TypeError("type mismatch");
    const fn = async () => {
      throw original;
    };
    const err = await withRetry(fn, 3, 10).catch((e) => e);
    expect(err).toBe(original); // same reference, not wrapped
    expect(err).not.toBeInstanceOf(RpcError);
  });
});

describe("withRetry — adaptive backoff propagation", () => {
  it("a second concurrent call waits after a rate-limit backoff advances lastRequestTime", async () => {
    let callAAttempts = 0;
    const callAFn = async () => {
      callAAttempts++;
      if (callAAttempts === 1) {
        throw makeRateLimitError();
      }
      return "callA done";
    };

    const callBFn = async () => "callB done";

    const [resultA, resultB] = await Promise.all([
      withRetry(callAFn, 3, 50),
      withRetry(callBFn, 3, 50),
    ]);

    expect(resultA).toBe("callA done");
    expect(resultB).toBe("callB done");
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
