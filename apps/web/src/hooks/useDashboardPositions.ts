import { useQuery } from "@tanstack/react-query";
import { getDashboardPositions } from "../api";

export const queryKeys = {
  dashboardPositions: ["dashboardPositions"] as const,
};

export function useDashboardPositions() {
  return useQuery({
    queryKey: queryKeys.dashboardPositions,
    queryFn: getDashboardPositions,
  });
}
