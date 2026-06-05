import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { getDashboardPositions, getSinglePositionSyncStatus, getSyncStatus, syncPositions, syncSinglePosition, SyncStatus } from "../api";

export const queryKeys = {
  dashboardPositions: ["dashboardPositions"] as const,
};

export function useDashboardPositions() {
  return useQuery({
    queryKey: queryKeys.dashboardPositions,
    queryFn: getDashboardPositions,
  });
}

export function useSyncPositions() {
  const queryClient = useQueryClient();
  const [isPolling, setIsPolling] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsPolling(false);
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
    };
  }, []);

  const trigger = useCallback(async () => {
    setError(null);
    setSyncStatus(null);
    try {
      await syncPositions();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    setIsPolling(true);
    intervalRef.current = setInterval(() => {
      void (async () => {
        try {
          const status = await getSyncStatus();
          setSyncStatus(status);
          if (status.status === "completed") {
            stopPolling();
            void queryClient.invalidateQueries({ queryKey: queryKeys.dashboardPositions });
          } else if (status.status === "failed") {
            stopPolling();
            setError(new Error(status.error ?? "Sync failed"));
          }
        } catch (err) {
          stopPolling();
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    }, 2000);
  }, [queryClient, stopPolling]);

  return { trigger, isPolling, syncStatus, error };
}

export function useSyncPosition(tokenId: string) {
  const queryClient = useQueryClient();
  const [isPolling, setIsPolling] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsPolling(false);
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
    };
  }, []);

  const trigger = useCallback(async () => {
    setError(null);
    setSyncStatus(null);
    try {
      await syncSinglePosition(tokenId);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    setIsPolling(true);
    intervalRef.current = setInterval(() => {
      void (async () => {
        try {
          const status = await getSinglePositionSyncStatus(tokenId);
          setSyncStatus(status);
          if (status.status === "completed") {
            stopPolling();
            void queryClient.invalidateQueries({ queryKey: queryKeys.dashboardPositions });
          } else if (status.status === "failed") {
            stopPolling();
            setError(new Error(status.error ?? "Sync failed"));
          }
        } catch (err) {
          stopPolling();
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    }, 2000);
  }, [tokenId, queryClient, stopPolling]);

  return { trigger, isPolling, syncStatus, error };
}
