import { useQuery } from "@tanstack/react-query";
import { getHedge } from "../api";

export function useHedge(tokenId: string | undefined) {
  return useQuery({
    queryKey: ["hedge", tokenId],
    queryFn: () => getHedge(tokenId!),
    enabled: !!tokenId,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
