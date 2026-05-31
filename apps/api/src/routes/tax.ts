import { listTaxTransactions, syncTaxTransactions, updateTaxTransaction } from "@lp-tracker/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  parseLimit,
  parseOffset,
  parseTaxTransactionLabel,
  ValidationError,
} from "../utils/validation.js";

type TaxTransactionUpdate = {
  label?: "Trade" | "Transfer" | null;
  comment?: string | null;
};

const updatableTaxTransactionFields = new Set(["label", "comment"]);
const maxTaxTransactionCommentLength = 1000;

function parseTaxTransactionUpdateBody(body: unknown): TaxTransactionUpdate {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be an object");
  }

  const update: TaxTransactionUpdate = {};
  for (const key of Object.keys(body)) {
    if (!updatableTaxTransactionFields.has(key)) {
      throw new ValidationError(`unknown field: ${key}`);
    }
  }

  const raw = body as Record<string, unknown>;
  if (Object.hasOwn(raw, "label")) {
    if (raw.label !== "Trade" && raw.label !== "Transfer" && raw.label !== null) {
      throw new ValidationError("label must be Trade, Transfer, or null");
    }
    update.label = raw.label;
  }

  if (Object.hasOwn(raw, "comment")) {
    if (typeof raw.comment !== "string" && raw.comment !== null) {
      throw new ValidationError("comment must be a string or null");
    }
    if (typeof raw.comment === "string" && raw.comment.length > maxTaxTransactionCommentLength) {
      throw new ValidationError(
        `comment must be at most ${maxTaxTransactionCommentLength} characters`,
      );
    }
    update.comment = raw.comment;
  }

  if (!Object.hasOwn(update, "label") && !Object.hasOwn(update, "comment")) {
    throw new ValidationError("request body must include label or comment");
  }

  return update;
}

async function handleTaxTransactionUpdate(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  id: string,
) {
  let update: TaxTransactionUpdate;
  try {
    update = parseTaxTransactionUpdateBody(request.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return reply.status(400).send({ error: err.message });
    }
    throw err;
  }

  let transaction;
  try {
    transaction = await updateTaxTransaction(id, update);
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({ error: "Failed to update tax transaction" });
  }

  if (transaction === null) {
    return reply.status(404).send({ error: "Tax transaction not found", id });
  }

  return { transaction };
}

export async function taxRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/tax/transactions/sync", async (_request, reply) => {
    try {
      const summary = await syncTaxTransactions(fastify.lpConfig);
      return { sync: summary };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(503).send({ error: "Failed to sync tax transactions" });
    }
  });

  fastify.get<{
    Querystring: { limit?: string; offset?: string; label?: string };
  }>(
    "/tax/transactions",
    async (
      request: FastifyRequest<{
        Querystring: { limit?: string; offset?: string; label?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { limit: limitRaw, offset: offsetRaw, label: labelRaw } = request.query;

      let limit: number;
      let offset: number;
      let label: "Trade" | "Transfer" | undefined;
      try {
        limit = parseLimit(limitRaw, 50, 200);
        offset = parseOffset(offsetRaw, 0);
        label = parseTaxTransactionLabel(labelRaw);
      } catch (err) {
        if (err instanceof ValidationError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }

      const transactions = listTaxTransactions(limit, offset, label);
      return { transactions };
    },
  );

  fastify.patch<{
    Params: { id: string };
  }>(
    "/tax/transactions/:id",
    async (
      request: FastifyRequest<{
        Params: { id: string };
      }>,
      reply: FastifyReply,
    ) => {
      return handleTaxTransactionUpdate(fastify, request, reply, request.params.id);
    },
  );

  fastify.patch<{
    Params: { "*": string };
  }>(
    "/tax/transactions/*",
    async (
      request: FastifyRequest<{
        Params: { "*": string };
      }>,
      reply: FastifyReply,
    ) => {
      return handleTaxTransactionUpdate(fastify, request, reply, request.params["*"]);
    },
  );
}
