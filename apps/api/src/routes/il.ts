import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getILView, NotFoundError, RpcError } from "@lp-tracker/core";
import { isNumericString } from "../utils/validation.js";

export async function ilRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/il", async (_request: FastifyRequest, _reply: FastifyReply) => {
    const config = fastify.lpConfig;
    const positions = await getILView(config);
    return { positions };
  });

  fastify.get<{ Params: { tokenId: string } }>(
    "/positions/:tokenId/il",
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

      const config = fastify.lpConfig;

      try {
        const positions = await getILView(config, tokenId);
        const position = positions[0];
        return { position };
      } catch (err) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ error: "Position not found", tokenId });
        }
        if (err instanceof RpcError && err.code === -32005) {
          return reply
            .status(503)
            .send({ error: "RPC rate limited, try again later" });
        }
        throw err;
      }
    }
  );
}
