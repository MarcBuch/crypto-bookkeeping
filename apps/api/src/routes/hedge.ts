import {
  assignHedgeEvent,
  getHedgeEvents,
  getHedgeView,
  listCachedPositionViews,
  listHedgeEvents,
} from "@lp-tracker/core";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import { isNumericString } from "../utils/validation.js";

type HedgeAssignmentBody = {
  tokenId: string | null;
};

type HedgesQuery = {
  assigned?: "assigned" | "unassigned" | "all";
};

function parsePositiveSafeInteger(value: string): number | null {
  if (!isNumericString(value)) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function isKnownPositionToken(fastify: FastifyInstance, tokenId: string): boolean {
  if (fastify.lpConfig.positions?.[tokenId]) {
    return true;
  }

  return listCachedPositionViews().some(
    (view) => typeof view.tokenId === "string" && view.tokenId === tokenId,
  );
}

export async function hedgeRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: HedgesQuery }>("/hedges", async (request, reply) => {
    const assigned = request.query.assigned ?? "all";

    if (assigned !== "all" && assigned !== "assigned" && assigned !== "unassigned") {
      return reply
        .status(400)
        .send({ error: "assigned must be one of: assigned, unassigned, all" });
    }

    const hedges = listHedgeEvents().filter((hedge) => {
      if (assigned === "assigned") return hedge.token_id !== null;
      if (assigned === "unassigned") return hedge.token_id === null;
      return true;
    });

    return reply.status(200).send({ hedges });
  });

  fastify.patch<{ Params: { id: string }; Body: HedgeAssignmentBody }>(
    "/hedges/:id/assignment",
    async (request, reply) => {
      const hedgeId = parsePositiveSafeInteger(request.params.id);
      if (hedgeId === null) {
        return reply.status(400).send({ error: "id must be a positive safe integer" });
      }

      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return reply.status(400).send({ error: "body must be an object" });
      }

      if (!("tokenId" in body)) {
        return reply.status(400).send({ error: "tokenId must be a numeric string or null" });
      }

      if (
        body.tokenId !== null &&
        (typeof body.tokenId !== "string" || !isNumericString(body.tokenId))
      ) {
        return reply.status(400).send({ error: "tokenId must be a numeric string or null" });
      }

      if (body.tokenId !== null && !isKnownPositionToken(fastify, body.tokenId)) {
        return reply.status(404).send({ error: "Position not found", tokenId: body.tokenId });
      }

      const hedge = assignHedgeEvent(hedgeId, body.tokenId);
      if (!hedge) {
        return reply.status(404).send({ error: "Hedge event not found", id: request.params.id });
      }

      return reply.status(200).send({ hedge });
    },
  );

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

      if (!isKnownPositionToken(fastify, tokenId)) {
        return reply.status(404).send({ error: "Position not found", tokenId });
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
