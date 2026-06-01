import { listCachedPnLViews, getPositionsCacheSyncedAt } from "@lp-tracker/core";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import { isNumericString } from "../utils/validation.js";

export async function pnlRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /pnl — read from cache (no live RPC)
  fastify.get("/pnl", async (_request: FastifyRequest, _reply: FastifyReply) => {
    const positions = listCachedPnLViews();
    const syncedAt = getPositionsCacheSyncedAt();
    return { positions, syncedAt };
  });

  // GET /positions/:tokenId/pnl — filter from cache
  fastify.get<{ Params: { tokenId: string } }>(
    "/positions/:tokenId/pnl",
    async (request: FastifyRequest<{ Params: { tokenId: string } }>, reply: FastifyReply) => {
      const { tokenId } = request.params;

      if (!isNumericString(tokenId)) {
        return reply.status(400).send({ error: "tokenId must be a numeric string" });
      }

      const positions = listCachedPnLViews();
      const position = positions.find((p) => (p as { tokenId: string }).tokenId === tokenId);

      if (!position) {
        return reply.status(404).send({ error: "Position not found", tokenId });
      }

      return { position };
    },
  );
}
