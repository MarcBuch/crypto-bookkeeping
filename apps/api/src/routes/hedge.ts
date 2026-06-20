import { getHedgeView, getHedgeEvents } from "@lp-tracker/core";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import { isNumericString } from "../utils/validation.js";

export async function hedgeRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /positions/:tokenId/hedge — fetch hedge view from Hyperliquid
  fastify.get<{ Params: { tokenId: string } }>(
    "/positions/:tokenId/hedge",
    async (request: FastifyRequest<{ Params: { tokenId: string } }>, reply: FastifyReply) => {
      const { tokenId } = request.params;

      if (!isNumericString(tokenId)) {
        return reply.status(400).send({ error: "tokenId must be a numeric string" });
      }

      const config = fastify.lpConfig;

      // Check if position exists in config
      if (!config.positions?.[tokenId]) {
        return reply.status(404).send({ error: "Position not found", tokenId });
      }

      // Check if hedge is configured for this position
      if (!config.positions[tokenId].hedge) {
        return reply.status(404).send({ error: "No hedge configured for this position", tokenId });
      }

      try {
        const hedgeView = await getHedgeView(config, tokenId);
        return reply.status(200).send(hedgeView);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({ error: errorMessage, tokenId });
      }
    },
  );

  // GET /positions/:tokenId/hedge/events — fetch hedge lifecycle events
  fastify.get<{ Params: { tokenId: string } }>(
    "/positions/:tokenId/hedge/events",
    async (request: FastifyRequest<{ Params: { tokenId: string } }>, reply: FastifyReply) => {
      const { tokenId } = request.params;

      if (!isNumericString(tokenId)) {
        return reply.status(400).send({ error: "tokenId must be a numeric string" });
      }

      const config = fastify.lpConfig;

      // Check if position exists in config
      if (!config.positions?.[tokenId]) {
        return reply.status(404).send({ error: "Position not found", tokenId });
      }

      // Check if hedge is configured for this position (mirrors /hedge endpoint)
      if (!config.positions[tokenId].hedge) {
        return reply.status(404).send({ error: "No hedge configured for this position", tokenId });
      }

      try {
        const events = await Promise.resolve(getHedgeEvents(tokenId));
        return reply.status(200).send({ events, tokenId });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: errorMessage, tokenId });
      }
    },
  );
}
