import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppProviders } from "../../src/app-providers";
import { NotFound, createAppRouter } from "../../src/router";

describe("router shell", () => {
  it("registers the dashboard as the index route", () => {
    const router = createAppRouter();

    expect(Object.keys(router.routesByPath)).toContain("/");
    expect(router.routesByPath["/"]?.path).toBe("/");
  });

  it("accepts memory history for deterministic route tests", () => {
    const history = createMemoryHistory({ initialEntries: ["/missing"] });
    const router = createAppRouter({ history });

    expect(router.options.history).toBe(history);
    expect(router.options.history?.location.pathname).toBe("/missing");
  });

  it("keeps QueryClientProvider outside RouterProvider", () => {
    const queryClient = new QueryClient();
    const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ["/"] }) });
    const element = AppProviders({ queryClient, router });

    expect(isValidElement(element)).toBe(true);
    expect(element.type).toBe(QueryClientProvider);
    expect(element.props.client).toBe(queryClient);

    const child = element.props.children;
    expect(isValidElement(child)).toBe(true);
    const routerElement = child as ReactElement<{ router: typeof router }>;
    expect(routerElement.type).toBe(RouterProvider);
    expect(routerElement.props.router).toBe(router);
  });

  it("renders a stable not-found fallback for unknown routes", () => {
    const html = renderToStaticMarkup(<NotFound />);

    expect(html).toContain("Route Not Found");
    expect(html).toContain("No dashboard route exists here");
    expect(html).toContain("Return to the portfolio dashboard");
  });
});
