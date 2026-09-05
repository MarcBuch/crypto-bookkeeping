import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { AppShell } from "./AppShell";
import { App } from "./App";
import { TaxTransactions } from "./TaxTransactions";

export function NotFound() {
  return (
    <main className="min-h-screen bg-white px-4 py-10 text-neutral-950">
      <section className="mx-auto max-w-2xl rounded-3xl border border-neutral-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-semibold tracking-[0.28em] text-neutral-500 uppercase">
          Route Not Found
        </p>
        <h1 className="mt-3 text-3xl font-black tracking-[-0.03em]">
          No dashboard route exists here
        </h1>
        <p className="mt-3 text-sm leading-6 text-neutral-600">
          Return to the portfolio dashboard to monitor LP positions and range operations.
        </p>
      </section>
    </main>
  );
}

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: NotFound,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: App,
});

const taxTransactionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tax",
  component: TaxTransactions,
});

export const routeTree = rootRoute.addChildren([dashboardRoute, taxTransactionsRoute]);

type RouterOptions = Omit<Parameters<typeof createRouter>[0], "routeTree">;

export function createAppRouter(options?: RouterOptions) {
  return createRouter({ ...options, routeTree });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
