import { describe, expect, it } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";

import { NotFound, createAppRouter } from "../../src/router";

describe("router shell", () => {
  it("registers the dashboard and tax transaction routes", () => {
    const router = createAppRouter();

    expect(Object.keys(router.routesByPath)).toContain("/");
    expect(Object.keys(router.routesByPath)).toContain("/tax");
    expect(router.routesByPath["/"]?.path).toBe("/");
    expect(router.routesByPath["/tax"]).toBeDefined();
  });

  it("accepts memory history for deterministic route tests", () => {
    const history = createMemoryHistory({ initialEntries: ["/missing"] });
    const router = createAppRouter({ history });

    expect(router.options.history).toBe(history);
    expect(router.options.history?.location.pathname).toBe("/missing");
  });

  it("renders a stable not-found fallback for unknown routes", () => {
    const html = renderToStaticMarkup(<NotFound />);

    expect(html).toContain("Route Not Found");
    expect(html).toContain("No dashboard route exists here");
    expect(html).toContain("Return to the portfolio dashboard");
  });
});
