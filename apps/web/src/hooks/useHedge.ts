import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { getHedge } from "../api";

export function useHedge(tokenId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["hedge", tokenId],
    queryFn: () => getHedge(tokenId!),
    enabled: !!tokenId && enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false,
    retry: 2,
  });
}
