import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { AppProviders } from "./app-providers";
import { createAppRouter } from "./router";
import "./styles.css";

const queryClient = new QueryClient();
const router = createAppRouter();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppProviders queryClient={queryClient} router={router} />
  </React.StrictMode>
);
