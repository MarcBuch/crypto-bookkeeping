import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";

import { getHedge, type HedgeView } from "../api";

export function useHedge(tokenId: string | undefined, enabled = true) {
  return useQuery<HedgeView>({
    queryKey: ["hedge", tokenId],
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
      queryKey: ["hedge", tokenId] as const,
      queryFn: () => getHedge(tokenId),
      enabled,
      staleTime: 30_000,
      refetchInterval: enabled ? 60_000 : false,
      retry: 2,
    })),
  });
}
