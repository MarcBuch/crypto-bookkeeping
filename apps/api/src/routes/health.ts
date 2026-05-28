import type { FastifyInstance } from "fastify";

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/health", async (_request, _reply) => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });
}
