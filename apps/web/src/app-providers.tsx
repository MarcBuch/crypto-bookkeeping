import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import type { createAppRouter } from "./router";

export function AppProviders({
  queryClient,
  router,
}: {
  queryClient: QueryClient;
  router: ReturnType<typeof createAppRouter>;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
