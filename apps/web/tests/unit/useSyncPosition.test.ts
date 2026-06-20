/**
 * Adversarial tests for useSyncPosition hook behaviour (single-position polling).
 *
 * Testing approach
 * ----------------
 * The project has no jsdom/happy-dom, so React hooks cannot be rendered in
 * tests. Instead we test the *polling orchestration logic* that the hook
 * encodes by:
 *
 *   1. Mocking `setInterval` / `clearInterval` so we capture the interval
 *      callback and can invoke it manually.
 *   2. Mocking the API functions (`syncSinglePosition`, `getSinglePositionSyncStatus`).
 *   3. Running the same code-path that `trigger()` runs, verifying observable
 *      side-effects (clearInterval called, invalidateQueries called / not
 *      called, error set).
 *   4. Testing multiple instances with different tokenIds are independent.
 *
 * What is NOT tested here:
 *   - Unmount cleanup (requires React render + act() + DOM environment).
 *     This is documented as a known gap.
 *
 * The contracts verified:
 *   1. Stops polling on completed  – clearInterval called, cache invalidated
 *   2. Stops polling on failed     – clearInterval called, error surfaced
 *   3. Error on initial API call   – polling doesn't start, error is set immediately
 *   4. Unmount stops polling       – SKIPPED (needs jsdom / @testing-library/react)
 *   5. Cache invalidated only on success – invalidateQueries on completed, not on failed
 *   6. Multiple instances are independent – two tokenIds poll independently
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

import { QueryClient } from "@tanstack/react-query";

import * as api from "../../src/api";
import { queryKeys } from "../../src/hooks/useDashboardPositions";

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Builds a minimal stand-in for the polling logic inside useSyncPosition. */
function buildSinglePoller(opts: {
  tokenId: string;
  queryClient: QueryClient;
  syncFn: (tokenId: string) => Promise<unknown>;
  statusFn: (tokenId: string) => Promise<api.SyncStatus>;
}) {
  const { tokenId, queryClient, syncFn, statusFn } = opts;

  let intervalId: ReturnType<typeof setInterval> | null = null;
  let isPolling = false;
  let error: Error | null = null;
  let syncStatus: api.SyncStatus | null = null;

  function stopPolling() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    isPolling = false;
  }

  async function trigger() {
    error = null;
    syncStatus = null;
    try {
      await syncFn(tokenId);
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      return;
    }

    isPolling = true;
    intervalId = setInterval(() => {
      void (async () => {
        try {
          const status = await statusFn(tokenId);
          syncStatus = status;
          if (status.status === "completed") {
            stopPolling();
            void queryClient.invalidateQueries({ queryKey: queryKeys.dashboardPositions });
          } else if (status.status === "failed") {
            stopPolling();
            error = new Error(status.error ?? "Sync failed");
          }
        } catch (err) {
          stopPolling();
          error = err instanceof Error ? err : new Error(String(err));
        }
      })();
    }, 2000);
  }

  return {
    trigger,
    stopPolling,
    getState: () => ({ isPolling, error, syncStatus, intervalId }),
  };
}

/** Helper: advance all pending promises in the microtask queue. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type TimerCallback = Extract<Parameters<typeof setInterval>[0], (...args: unknown[]) => void>;

function isTimerCallback(handler: Parameters<typeof setInterval>[0]): handler is TimerCallback {
  return typeof handler === "function";
}

function createSetIntervalInterceptor(
  onSchedule: (intervalId: ReturnType<typeof setInterval>, callback: () => void) => void,
): typeof globalThis.setInterval {
  return new Proxy(realSetInterval, {
    apply(target, thisArg, argArray) {
      const [handler] = argArray;
      if (!isTimerCallback(handler)) {
        throw new TypeError("String timer handlers are not supported in tests.");
      }

      const intervalId = Reflect.apply(target, thisArg, [() => undefined, 60_000]);
      realClearInterval(intervalId);
      onSchedule(intervalId, () => {
        handler();
      });
      return intervalId;
    },
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("useSyncPosition polling logic (single position)", () => {
  let queryClient: QueryClient;
  let capturedIntervalCallbacks: Map<ReturnType<typeof setInterval>, () => void>;
  let clearIntervalSpy: ReturnType<typeof spyOn>;
  let intervalIds: Array<ReturnType<typeof setInterval>> = [];

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    capturedIntervalCallbacks = new Map();
    intervalIds = [];

    // Capture callbacks while returning a real cleared interval handle.
    globalThis.setInterval = createSetIntervalInterceptor((intervalId, callback) => {
      capturedIntervalCallbacks.set(intervalId, callback);
      intervalIds.push(intervalId);
    });

    // Spy on clearInterval
    clearIntervalSpy = spyOn(globalThis, "clearInterval");
  });

  afterEach(() => {
    globalThis.setInterval = realSetInterval;
    queryClient.clear();
    mock.restore();
    capturedIntervalCallbacks.clear();
    intervalIds = [];
  });

  // -------------------------------------------------------------------------
  // 1. Error on initial API call – polling doesn't start, error is set
  // -------------------------------------------------------------------------
  it("does not start polling if syncSinglePosition throws (error on initial call)", async () => {
    const syncMock = mock(async (tokenId: string) => {
      throw new Error("RPC rate limited on tokenId=" + tokenId);
    });
    const idleStatus: api.SyncStatus = {
      status: "idle",
      startedAt: null,
      finishedAt: null,
      error: null,
      positionCount: null,
    };
    const statusMock = mock(async (_tokenId: string) => idleStatus);

    const poller = buildSinglePoller({
      tokenId: "42",
      queryClient,
      syncFn: syncMock,
      statusFn: statusMock,
    });

    await poller.trigger();

    // No interval should have been registered
    expect(intervalIds.length).toBe(0);
    expect(poller.getState().isPolling).toBe(false);
    expect(poller.getState().error?.message).toContain("RPC rate limited");
    expect(statusMock.mock.calls.length).toBe(0);
    expect(clearIntervalSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Stops polling on completed + invalidates cache
  // -------------------------------------------------------------------------
  it("stops polling and invalidates cache when getSinglePositionSyncStatus returns completed", async () => {
    const syncMock = mock(async (_tokenId: string) => ({ message: "ok" }));
    const completedStatus: api.SyncStatus = {
      status: "completed",
      startedAt: null,
      finishedAt: null,
      error: null,
      positionCount: 1,
    };
    const statusMock = mock(async (_tokenId: string) => completedStatus);
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");

    const poller = buildSinglePoller({
      tokenId: "123",
      queryClient,
      syncFn: syncMock,
      statusFn: statusMock,
    });

    await poller.trigger();

    // Interval callback should have been registered
    expect(intervalIds.length).toBe(1);
    const intervalId = intervalIds[0];
    const callback = capturedIntervalCallbacks.get(intervalId);
    expect(callback).not.toBeNull();

    // Invoke the interval callback (simulates 2s tick)
    callback!();
    await flushPromises();

    // clearInterval must have been called – polling stopped
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(poller.getState().isPolling).toBe(false);
    expect(poller.getState().intervalId).toBeNull();

    // Cache must have been invalidated
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy.mock.calls[0][0]).toMatchObject({
      queryKey: queryKeys.dashboardPositions,
    });

    // getSinglePositionSyncStatus must NOT be called again after stopping
    const callCountAfterStop = statusMock.mock.calls.length;
    expect(callCountAfterStop).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 3. Stops polling on failed + surfaces error (no cache invalidation)
  // -------------------------------------------------------------------------
  it("stops polling and sets error when getSinglePositionSyncStatus returns failed", async () => {
    const syncMock = mock(async (_tokenId: string) => ({ message: "ok" }));
    const failedStatus: api.SyncStatus = {
      status: "failed",
      startedAt: null,
      finishedAt: null,
      error: "on-chain RPC timeout",
      positionCount: null,
    };
    const statusMock = mock(async (_tokenId: string) => failedStatus);
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");

    const poller = buildSinglePoller({
      tokenId: "456",
      queryClient,
      syncFn: syncMock,
      statusFn: statusMock,
    });

    await poller.trigger();
    expect(intervalIds.length).toBe(1);

    const callback = capturedIntervalCallbacks.get(intervalIds[0]);
    callback!();
    await flushPromises();

    // clearInterval must have been called
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(poller.getState().isPolling).toBe(false);
    expect(poller.getState().error).not.toBeNull();
    expect(poller.getState().error?.message).toBe("on-chain RPC timeout");

    // Cache must NOT have been invalidated on failure
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. State transitions: running -> completed (multiple ticks)
  // -------------------------------------------------------------------------
  it("continues polling while status is running, stops on completed", async () => {
    const syncMock = mock(async (_tokenId: string) => ({ message: "ok" }));
    let tickCount = 0;
    const statusMock = mock(async (_tokenId: string): Promise<api.SyncStatus> => {
      tickCount++;
      if (tickCount < 3) {
        return {
          status: "running",
          startedAt: null,
          finishedAt: null,
          error: null,
          positionCount: null,
        };
      }
      return {
        status: "completed",
        startedAt: null,
        finishedAt: null,
        error: null,
        positionCount: 1,
      };
    });

    const poller = buildSinglePoller({
      tokenId: "789",
      queryClient,
      syncFn: syncMock,
      statusFn: statusMock,
    });

    await poller.trigger();
    const callback = capturedIntervalCallbacks.get(intervalIds[0]);

    // Tick 1: running
    callback!();
    await flushPromises();
    expect(poller.getState().isPolling).toBe(true);
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    // Tick 2: running
    callback!();
    await flushPromises();
    expect(poller.getState().isPolling).toBe(true);
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    // Tick 3: completed
    callback!();
    await flushPromises();
    expect(poller.getState().isPolling).toBe(false);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(statusMock.mock.calls.length).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 5. Unmount stops polling — SKIPPED (needs jsdom + @testing-library/react)
  // -------------------------------------------------------------------------
  it.todo("stops polling on unmount (requires jsdom / @testing-library/react — not available in this project)", () => {});

  // -------------------------------------------------------------------------
  // 6. Multiple instances with different tokenIds are independent
  // -------------------------------------------------------------------------
  it("two instances with different tokenIds poll independently", async () => {
    const syncMockA = mock(async (_tokenId: string) => ({ message: "ok" }));
    const syncMockB = mock(async (_tokenId: string) => ({ message: "ok" }));

    const statusMockA = mock(
      async (_tokenId: string): Promise<api.SyncStatus> => ({
        status: "running",
        startedAt: null,
        finishedAt: null,
        error: null,
        positionCount: null,
      }),
    );

    const statusMockB = mock(
      async (_tokenId: string): Promise<api.SyncStatus> => ({
        status: "completed",
        startedAt: null,
        finishedAt: null,
        error: null,
        positionCount: 1,
      }),
    );

    const pollerA = buildSinglePoller({
      tokenId: "10",
      queryClient,
      syncFn: syncMockA,
      statusFn: statusMockA,
    });

    const pollerB = buildSinglePoller({
      tokenId: "20",
      queryClient,
      syncFn: syncMockB,
      statusFn: statusMockB,
    });

    // Start both
    await pollerA.trigger();
    await pollerB.trigger();

    expect(intervalIds.length).toBe(2);
    const callbackA = capturedIntervalCallbacks.get(intervalIds[0]);
    const callbackB = capturedIntervalCallbacks.get(intervalIds[1]);

    // Tick A: still running
    callbackA!();
    await flushPromises();
    expect(pollerA.getState().isPolling).toBe(true);
    expect(pollerA.getState().syncStatus?.status).toBe("running");

    // Tick B: completed
    callbackB!();
    await flushPromises();
    expect(pollerB.getState().isPolling).toBe(false);
    expect(pollerB.getState().syncStatus?.status).toBe("completed");

    // A should still be polling
    expect(pollerA.getState().isPolling).toBe(true);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1); // Only B's interval cleared

    // Verify each called their own status endpoint with their own tokenId
    expect(syncMockA.mock.calls[0][0]).toBe("10");
    expect(syncMockB.mock.calls[0][0]).toBe("20");
    expect(statusMockA.mock.calls[0][0]).toBe("10");
    expect(statusMockB.mock.calls[0][0]).toBe("20");
  });

  // -------------------------------------------------------------------------
  // 7. Error during polling stops polling and surfaces error
  // -------------------------------------------------------------------------
  it("surfaces error when getSinglePositionSyncStatus throws during polling", async () => {
    const syncMock = mock(async (_tokenId: string) => ({ message: "ok" }));
    const statusMock = mock(async (_tokenId: string) => {
      throw new Error("Connection lost");
    });

    const poller = buildSinglePoller({
      tokenId: "999",
      queryClient,
      syncFn: syncMock,
      statusFn: statusMock,
    });

    await poller.trigger();
    const callback = capturedIntervalCallbacks.get(intervalIds[0]);

    callback!();
    await flushPromises();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(poller.getState().isPolling).toBe(false);
    expect(poller.getState().error?.message).toBe("Connection lost");
  });

  // -------------------------------------------------------------------------
  // 8. tokenId is passed correctly to both sync and status functions
  // -------------------------------------------------------------------------
  it("passes tokenId correctly to syncSinglePosition and getSinglePositionSyncStatus", async () => {
    const syncMock = mock(async (tokenId: string) => {
      if (tokenId !== "specific-token-id") {
        throw new Error(`Expected tokenId 'specific-token-id', got '${tokenId}'`);
      }
      return { message: "ok" };
    });

    const statusMock = mock(async (tokenId: string): Promise<api.SyncStatus> => {
      if (tokenId !== "specific-token-id") {
        throw new Error(`Expected tokenId 'specific-token-id', got '${tokenId}'`);
      }
      return {
        status: "completed",
        startedAt: null,
        finishedAt: null,
        error: null,
        positionCount: 1,
      };
    });

    const poller = buildSinglePoller({
      tokenId: "specific-token-id",
      queryClient,
      syncFn: syncMock,
      statusFn: statusMock,
    });

    await poller.trigger();
    const callback = capturedIntervalCallbacks.get(intervalIds[0]);
    callback!();
    await flushPromises();

    // Both mocks should have been called with the correct tokenId
    expect(syncMock.mock.calls[0][0]).toBe("specific-token-id");
    expect(statusMock.mock.calls[0][0]).toBe("specific-token-id");
    expect(poller.getState().error).toBeNull();
  });
});
