import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  assignHedgeEvent,
  getHedge,
  getHedges,
  type HedgeEvent,
  type HedgesAssignedFilter,
  type HedgeView,
} from "../api";
import { queryKeys } from "./useDashboardPositions";

export const hedgeQueryKeys = {
  all: ["hedge"] as const,
  detail: (tokenId: string | undefined) => ["hedge", tokenId] as const,
  lists: ["hedges"] as const,
  list: (assigned: HedgesAssignedFilter = "all") => ["hedges", assigned] as const,
};

export async function invalidateHedgeQueries(
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: hedgeQueryKeys.lists }),
    queryClient.invalidateQueries({ queryKey: hedgeQueryKeys.all }),
  ]);
}

export function useHedge(tokenId: string | undefined, enabled = true) {
  return useQuery<HedgeView>({
    queryKey: hedgeQueryKeys.detail(tokenId),
    queryFn: () => getHedge(tokenId!),
    enabled: !!tokenId && enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false,
    retry: 2,
  });
}

export function useHedges(tokenIds: string[], enabled = true) {
  return useQueries({
    queries: tokenIds.map((tokenId) => ({
      queryKey: hedgeQueryKeys.detail(tokenId),
      queryFn: () => getHedge(tokenId),
      enabled,
      staleTime: 30_000,
      refetchInterval: enabled ? 60_000 : false,
      retry: 2,
    })),
  });
}

export function useHedgeEventsList(assigned: HedgesAssignedFilter = "all", enabled = true) {
  return useQuery<{ hedges: HedgeEvent[] }>({
    queryKey: hedgeQueryKeys.list(assigned),
    queryFn: () => getHedges({ assigned }),
    enabled,
    staleTime: 15_000,
    refetchInterval: enabled ? 30_000 : false,
    retry: 2,
  });
}

export function useAssignHedgeEvent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, tokenId }: { id: number; tokenId: string | null }) =>
      assignHedgeEvent(id, tokenId),
    onSuccess: async () => {
      await Promise.all([
        invalidateHedgeQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboardPositions }),
      ]);
    },
  });
}
