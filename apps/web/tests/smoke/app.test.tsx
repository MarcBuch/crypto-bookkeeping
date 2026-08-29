import { describe, expect, it } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import { App, ErrorState } from "../../src/App";
import { queryKeys } from "../../src/hooks/useDashboardPositions";

function renderAppWithQueryClient(queryClient: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

describe("app smoke", () => {
  it("renders the dashboard shell from cached app data", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.dashboardPositions, { positions: [], syncedAt: null });

    const html = renderAppWithQueryClient(queryClient);

    expect(html).toContain("HyperEVM ProjectX");
    expect(html).toContain("No LP positions found");
    expect(html).not.toContain("Loading LP positions");
  });

  it("renders loading state when route data is pending", () => {
    const html = renderAppWithQueryClient(new QueryClient());

    expect(html).toContain("HyperEVM ProjectX");
    expect(html).toContain("Loading LP positions");
    expect(html).not.toContain("No LP positions found");
    expect(html).not.toContain("Could not load LP positions");
  });

  it("renders error state for API failures", () => {
    // Test ErrorState directly — avoids coupling to React Query's internal
    // cache API to force an error state, while still verifying the component
    // that App renders when useDashboardPositions returns an error.
    const html = renderToStaticMarkup(<ErrorState error={new Error("RPC rate limited")} />);

    expect(html).toContain("Could not load LP positions");
    expect(html).toContain("RPC rate limited");
  });
});
