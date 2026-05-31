import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { errorHandlerPlugin } from "./plugins/errorHandler.js";
import { healthRoutes } from "./routes/health.js";
import { historyRoutes } from "./routes/history.js";
import { ilRoutes } from "./routes/il.js";
import { pnlRoutes } from "./routes/pnl.js";
import { positionsRoutes } from "./routes/positions.js";
import { taxRoutes } from "./routes/tax.js";

export async function buildServer(config?: Config): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: true });

  // Load config if not provided
  const resolvedConfig = config ?? loadConfig();

  // Decorate the instance with the config so route plugins can access it
  fastify.decorate("lpConfig", resolvedConfig);

  // Register error handler plugin first
  await fastify.register(errorHandlerPlugin);

  await fastify.register(cors, {
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    origin: process.env.CORS_ORIGIN ?? process.env.NODE_ENV !== "production",
  });

  // Register route plugins
  fastify.register(healthRoutes);
  fastify.register(positionsRoutes);
  fastify.register(pnlRoutes);
  fastify.register(ilRoutes);
  fastify.register(historyRoutes);
  fastify.register(taxRoutes);

  return fastify;
}

// Only start listening when run directly (not imported as a module)
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1].endsWith("index.ts") ||
    process.argv[1].endsWith("index.js"));

if (isMain) {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const host = "0.0.0.0";

  const server = await buildServer();
  await server.listen({ port, host });
}
