import { describe, expect, it } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";

import { App, ErrorState } from "../../src/App";
import { AppProviders } from "../../src/app-providers";
import { queryKeys } from "../../src/hooks/useDashboardPositions";
import { createAppRouter } from "../../src/router";

function renderAppWithQueryClient(queryClient: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

describe("app smoke", () => {
  it("composes providers around the routed dashboard", () => {
    const queryClient = new QueryClient();
    const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ["/"] }) });
    const element = AppProviders({ queryClient, router });

    expect(element.props.client).toBe(queryClient);
    expect(element.props.children.props.router).toBe(router);
    expect(router.routesByPath["/"]?.path).toBe("/");
  });

  it("renders the dashboard shell from cached app data", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.dashboardPositions, []);

    const html = renderAppWithQueryClient(queryClient);

    expect(html).toContain("Portfolio Risk &amp; Range Operations");
    expect(html).toContain("No LP positions found");
    expect(html).not.toContain("Loading LP positions");
  });

  it("renders loading state when route data is pending", () => {
    const html = renderAppWithQueryClient(new QueryClient());

    expect(html).toContain("Portfolio Risk &amp; Range Operations");
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
