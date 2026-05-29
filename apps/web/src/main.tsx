import { QueryClient } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";

import { AppProviders } from "./app-providers";
import { createAppRouter } from "./router";

// eslint-disable-next-line import/no-unassigned-import -- Vite loads global CSS through side-effect imports.
import "./styles.css";

const queryClient = new QueryClient();
const router = createAppRouter();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppProviders queryClient={queryClient} router={router} />
  </React.StrictMode>,
);
