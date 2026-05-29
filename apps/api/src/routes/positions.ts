import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getPositionsView } from "@lp-tracker/core";
import { isNumericString } from "../utils/validation.js";

export async function positionsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/positions", async (_request: FastifyRequest, _reply: FastifyReply) => {
    const config = fastify.lpConfig;
    const positions = await getPositionsView(config);
    return { positions };
  });

  fastify.get<{ Params: { tokenId: string } }>(
    "/positions/:tokenId",
    async (request: FastifyRequest<{ Params: { tokenId: string } }>, reply: FastifyReply) => {
      const { tokenId } = request.params;

      if (!isNumericString(tokenId)) {
        return reply.status(400).send({ error: "tokenId must be a numeric string" });
      }

      const config = fastify.lpConfig;
      const positions = await getPositionsView(config);
      const position = positions.find((p) => p.tokenId === tokenId);

      if (!position) {
        return reply.status(404).send({ error: "Position not found", tokenId });
      }

      return { position };
    },
  );
}
