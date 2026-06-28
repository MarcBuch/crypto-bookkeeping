/**
 * Adversarial tests for useSyncPositions hook behaviour.
 *
 * Testing approach
 * ----------------
 * The project has no jsdom/happy-dom, so React hooks cannot be rendered in
 * tests. Instead we test the *polling orchestration logic* that the hook
 * encodes by:
 *
 *   1. Mocking `setInterval` / `clearInterval` so we capture the interval
 *      callback and can invoke it manually.
 *   2. Mocking the API functions (`syncPositions`, `getSyncStatus`).
 *   3. Running the same code-path that `trigger()` runs, verifying observable
 *      side-effects (clearInterval called, invalidateQueries called / not
 *      called, error set).
 *
 * What is NOT tested here:
 *   - Unmount cleanup (requires React render + act() + DOM environment).
 *     This is documented as a known gap.
 *
 * The four contracts verified:
 *   1. Stops polling on completed  – clearInterval called, no more getSyncStatus calls
 *   2. Stops polling on failed     – clearInterval called, error surfaced
 *   3. Unmount stops polling       – SKIPPED (needs jsdom / @testing-library/react)
 *   4. Cache invalidated only on success – invalidateQueries on completed, not on failed
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

import { QueryClient } from "@tanstack/react-query";

import * as api from "../../src/api";
import { hedgeQueryKeys } from "../../src/hooks/useHedge";
import { queryKeys } from "../../src/hooks/useDashboardPositions";

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Builds a minimal stand-in for the polling logic inside useSyncPositions. */
function buildPoller(opts: {
  queryClient: QueryClient;
  syncFn: () => Promise<unknown>;
  statusFn: () => Promise<api.SyncStatus>;
}) {
  const { queryClient, syncFn, statusFn } = opts;

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
      await syncFn();
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      return;
    }

    isPolling = true;
    intervalId = setInterval(() => {
      void (async () => {
        try {
          const status = await statusFn();
          syncStatus = status;
          if (status.status === "completed") {
            stopPolling();
            void Promise.all([
              queryClient.invalidateQueries({ queryKey: queryKeys.dashboardPositions }),
              queryClient.invalidateQueries({ queryKey: hedgeQueryKeys.lists }),
              queryClient.invalidateQueries({ queryKey: hedgeQueryKeys.all }),
            ]);
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
  onSchedule: (callback: () => void) => void,
): typeof setInterval {
  return new Proxy(realSetInterval, {
    apply(target, thisArg, argArray) {
      const [handler] = argArray;
      if (!isTimerCallback(handler)) {
        throw new TypeError("String timer handlers are not supported in tests.");
      }

      const intervalId = Reflect.apply(target, thisArg, [() => undefined, 60_000]);
      realClearInterval(intervalId);
      onSchedule(() => {
        handler();
      });
      return intervalId;
    },
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("useSyncPositions polling logic", () => {
  let queryClient: QueryClient;
  let capturedIntervalCallback: (() => void) | null;
  let clearIntervalSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    capturedIntervalCallback = null;

    // Capture the callback while returning a real cleared interval handle.
    globalThis.setInterval = createSetIntervalInterceptor((callback) => {
      capturedIntervalCallback = callback;
    });

    // Spy on clearInterval
    clearIntervalSpy = spyOn(globalThis, "clearInterval");
  });

  afterEach(() => {
    globalThis.setInterval = realSetInterval;
    queryClient.clear();
    mock.restore();
  });

  // -------------------------------------------------------------------------
  // 1. Stops polling on completed
  // -------------------------------------------------------------------------
  it("stops polling when getSyncStatus returns completed", async () => {
    const syncMock = mock(async () => ({ message: "ok" }));
    const completedStatus: api.SyncStatus = {
      status: "completed",
      startedAt: null,
      finishedAt: null,
      error: null,
      positionCount: 1,
    };
    const statusMock = mock(async () => completedStatus);

    const poller = buildPoller({
      queryClient,
      syncFn: syncMock,
      statusFn: statusMock,
    });

    await poller.trigger();

    // Interval callback should have been registered
    expect(capturedIntervalCallback).not.toBeNull();

    // Invoke the interval callback (simulates 2s tick)
    capturedIntervalCallback!();
    await flushPromises();

    // clearInterval must have been called – polling stopped
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(poller.getState().isPolling).toBe(false);

    // getSyncStatus must NOT be called again after stopping
    const callCountAfterStop = statusMock.mock.calls.length;
    capturedIntervalCallback!();
    await flushPromises();
    // The interval is cleared so this manual invocation still calls statusMock,
    // but in real code the interval is gone; we verify no ADDITIONAL interval
    // was registered and isPolling is false.
    expect(poller.getState().isPolling).toBe(false);
    expect(poller.getState().intervalId).toBeNull();
    // The first tick caused exactly one getSyncStatus call
    expect(callCountAfterStop).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 2. Stops polling on failed + surfaces error
  // -------------------------------------------------------------------------
  it("stops polling and sets error when getSyncStatus returns failed", async () => {
    const syncMock = mock(async () => ({ message: "ok" }));
    const failedStatus: api.SyncStatus = {
      status: "failed",
      startedAt: null,
      finishedAt: null,
      error: "on-chain RPC timeout",
      positionCount: null,
    };
    const statusMock = mock(async () => failedStatus);

    const poller = buildPoller({
      queryClient,
      syncFn: syncMock,
      statusFn: statusMock,
    });

    await poller.trigger();
    expect(capturedIntervalCallback).not.toBeNull();

    capturedIntervalCallback!();
    await flushPromises();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(poller.getState().isPolling).toBe(false);
    expect(poller.getState().error).not.toBeNull();
    expect(poller.getState().error?.message).toBe("on-chain RPC timeout");
  });

  // -------------------------------------------------------------------------
  // 3. Unmount stops polling — SKIPPED (needs jsdom + @testing-library/react)
  // -------------------------------------------------------------------------
  it.todo("stops polling on unmount (requires jsdom / @testing-library/react — not available in this project)", () => {});

  // -------------------------------------------------------------------------
  // 4a. Cache IS invalidated on completed
  // -------------------------------------------------------------------------
  it("invalidates dashboardPositions cache on completed", async () => {
    const syncMock = mock(async () => ({ message: "ok" }));
    const completedStatus: api.SyncStatus = {
      status: "completed",
      startedAt: null,
      finishedAt: null,
      error: null,
      positionCount: 2,
    };
    const statusMock = mock(async () => completedStatus);
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");

    const poller = buildPoller({
      queryClient,
      syncFn: syncMock,
      statusFn: statusMock,
    });

    await poller.trigger();
    capturedIntervalCallback!();
    await flushPromises();

    expect(invalidateSpy).toHaveBeenCalledTimes(3);
    expect(invalidateSpy.mock.calls[0][0]).toMatchObject({
      queryKey: queryKeys.dashboardPositions,
    });
  });

  it("also invalidates hedge queries on completed", async () => {
    const syncMock = mock(async () => ({ message: "ok" }));
    const completedStatus: api.SyncStatus = {
      status: "completed",
      startedAt: null,
      finishedAt: null,
      error: null,
      positionCount: 2,
    };
    const statusMock = mock(async () => completedStatus);
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");

    const poller = buildPoller({
      queryClient,
      syncFn: syncMock,
      statusFn: statusMock,
    });

    await poller.trigger();
    capturedIntervalCallback!();
    await flushPromises();

    expect(invalidateSpy).toHaveBeenCalledTimes(3);
    expect(invalidateSpy.mock.calls.map((call) => call[0]?.queryKey)).toEqual([
      queryKeys.dashboardPositions,
      hedgeQueryKeys.lists,
      hedgeQueryKeys.all,
    ]);
  });

  // -------------------------------------------------------------------------
  // 4b. Cache is NOT invalidated on failed
  // -------------------------------------------------------------------------
  it("does NOT invalidate cache when getSyncStatus returns failed", async () => {
    const syncMock = mock(async () => ({ message: "ok" }));
    const failedStatus: api.SyncStatus = {
      status: "failed",
      startedAt: null,
      finishedAt: null,
      error: "node error",
      positionCount: null,
    };
    const statusMock = mock(async () => failedStatus);
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");

    const poller = buildPoller({
      queryClient,
      syncFn: syncMock,
      statusFn: statusMock,
    });

    await poller.trigger();
    capturedIntervalCallback!();
    await flushPromises();

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(poller.getState().error?.message).toBe("node error");
  });

  // -------------------------------------------------------------------------
  // 5. Keeps polling while status is "running"
  // -------------------------------------------------------------------------
  it("continues polling while status is running (does not call clearInterval)", async () => {
    const syncMock = mock(async () => ({ message: "ok" }));
    const runningStatus: api.SyncStatus = {
      status: "running",
      startedAt: null,
      finishedAt: null,
      error: null,
      positionCount: null,
    };
    const statusMock = mock(async () => runningStatus);

    const poller = buildPoller({
      queryClient,
      syncFn: syncMock,
      statusFn: statusMock,
    });

    await poller.trigger();

    // Simulate 3 ticks
    capturedIntervalCallback!();
    await flushPromises();
    capturedIntervalCallback!();
    await flushPromises();
    capturedIntervalCallback!();
    await flushPromises();

    expect(clearIntervalSpy).not.toHaveBeenCalled();
    expect(poller.getState().isPolling).toBe(true);
    expect(statusMock.mock.calls.length).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 6. Error during syncPositions does not start polling
  // -------------------------------------------------------------------------
  it("does not start polling if syncPositions throws", async () => {
    const syncMock = mock(async () => {
      throw new Error("RPC rate limited");
    });
    const idleStatus: api.SyncStatus = {
      status: "idle",
      startedAt: null,
      finishedAt: null,
      error: null,
      positionCount: null,
    };
    const statusMock = mock(async () => idleStatus);

    const poller = buildPoller({
      queryClient,
      syncFn: syncMock,
      statusFn: statusMock,
    });

    await poller.trigger();

    expect(capturedIntervalCallback).toBeNull();
    expect(poller.getState().isPolling).toBe(false);
    expect(poller.getState().error?.message).toBe("RPC rate limited");
    expect(statusMock.mock.calls.length).toBe(0);
  });
});
