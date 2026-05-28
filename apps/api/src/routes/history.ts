import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getHistoryView, NotFoundError } from "@lp-tracker/core";
import { isNumericString, parseLimit, ValidationError } from "../utils/validation.js";

export async function historyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { tokenId: string }; Querystring: { limit?: string } }>(
    "/positions/:tokenId/history",
    async (
      request: FastifyRequest<{
        Params: { tokenId: string };
        Querystring: { limit?: string };
      }>,
      reply: FastifyReply
    ) => {
      const { tokenId } = request.params;
      const { limit: limitRaw } = request.query;

      if (!isNumericString(tokenId)) {
        return reply
          .status(400)
          .send({ error: "tokenId must be a numeric string" });
      }

      let limit: number;
      try {
        limit = parseLimit(limitRaw, 20, 200);
      } catch (err) {
        if (err instanceof ValidationError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }

      try {
        const history = await getHistoryView(tokenId, limit);
        return { tokenId, history };
      } catch (err) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ error: "Position not found", tokenId });
        }
        throw err;
      }
    }
  );

  fastify.get<{ Params: { tokenId: string } }>(
    "/positions/:tokenId/snapshots",
    async (
      request: FastifyRequest<{ Params: { tokenId: string } }>,
      reply: FastifyReply
    ) => {
      const { tokenId } = request.params;

      if (!isNumericString(tokenId)) {
        return reply
          .status(400)
          .send({ error: "tokenId must be a numeric string" });
      }

      try {
        const snapshots = await getHistoryView(tokenId, 200);
        return { tokenId, snapshots };
      } catch (err) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ error: "Position not found", tokenId });
        }
        throw err;
      }
    }
  );
}
