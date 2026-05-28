import type { FastifyInstance } from "fastify";
import { NotFoundError, RpcError } from "@lp-tracker/core";
import { ValidationError } from "../utils/validation.js";

export async function errorHandlerPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof ValidationError) {
      return reply.status(400).send({ error: error.message });
    }

    if (error instanceof NotFoundError) {
      return reply.status(404).send({ error: error.message });
    }

    if (error instanceof RpcError && error.code === -32005) {
      return reply.status(503).send({ error: "RPC rate limited, try again later" });
    }

    // Log unexpected errors server-side
    fastify.log.error(error);
    return reply.status(500).send({ error: "Internal server error" });
  });

  fastify.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: "Route not found",
      path: request.url,
    });
  });
}
