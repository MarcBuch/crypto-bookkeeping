import {
  createManualTaxTransaction,
  countTaxTransactions,
  enrichTaxTransactionsEurValues,
  listTaxTransactions,
  syncTaxTransactions,
  updateTaxTransaction,
} from "@lp-tracker/core";
import type { ManualTaxTransactionInput } from "@lp-tracker/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  parseLimit,
  parseOffset,
  parseTaxTransactionLabel,
  ValidationError,
} from "../utils/validation.js";

type TaxTransactionUpdate = {
  hash?: string;
  block_number?: number | null;
  time_stamp?: string | null;
  from_address?: string | null;
  to_address?: string | null;
  value?: string | null;
  gas_used?: string | null;
  gas_price?: string | null;
  fee?: string | null;
  method_id?: string | null;
  function_name?: string | null;
  input?: string | null;
  contract_address?: string | null;
  token_symbol?: string | null;
  token_decimal?: number | null;
  token_name?: string | null;
  is_error?: number | null;
  label?: "Trade" | "Transfer" | "Approval" | "Repay Loan" | "Derivative" | null;
  incoming_quantity?: string | null;
  incoming_asset?: string | null;
  outgoing_quantity?: string | null;
  outgoing_asset?: string | null;
  cost_eur?: string | null;
  proceeds_eur?: string | null;
  gain_eur?: string | null;
  holding_duration_days?: number | null;
  comment?: string | null;
};

const updatableTaxTransactionFields = new Set([
  "hash",
  "block_number",
  "time_stamp",
  "from_address",
  "to_address",
  "value",
  "gas_used",
  "gas_price",
  "fee",
  "method_id",
  "function_name",
  "input",
  "contract_address",
  "token_symbol",
  "token_decimal",
  "token_name",
  "is_error",
  "label",
  "incoming_quantity",
  "incoming_asset",
  "outgoing_quantity",
  "outgoing_asset",
  "cost_eur",
  "proceeds_eur",
  "gain_eur",
  "holding_duration_days",
  "comment",
]);
const manualTaxTransactionFields = new Set([
  "id",
  "hash",
  "block_number",
  "time_stamp",
  "from_address",
  "to_address",
  "value",
  "gas_used",
  "gas_price",
  "fee",
  "method_id",
  "function_name",
  "input",
  "contract_address",
  "token_symbol",
  "token_decimal",
  "token_name",
  "is_error",
  "label",
  "incoming_quantity",
  "incoming_asset",
  "outgoing_quantity",
  "outgoing_asset",
  "cost_eur",
  "proceeds_eur",
  "gain_eur",
  "holding_duration_days",
  "comment",
]);
const manualTaxTransactionStringFields = [
  "time_stamp",
  "from_address",
  "to_address",
  "value",
  "gas_used",
  "gas_price",
  "fee",
  "method_id",
  "function_name",
  "input",
  "contract_address",
  "token_symbol",
  "token_name",
  "incoming_quantity",
  "incoming_asset",
  "outgoing_quantity",
  "outgoing_asset",
  "cost_eur",
  "proceeds_eur",
  "gain_eur",
] as const;
const manualTaxTransactionIntegerFields = [
  "block_number",
  "token_decimal",
  "is_error",
  "holding_duration_days",
] as const;
const manualTaxTransactionPatchStringFields = manualTaxTransactionStringFields;
const maxTaxTransactionCommentLength = 1000;

type TaxTransactionPagination = {
  limit: number;
  offset: number;
  label: "Trade" | "Transfer" | "Approval" | "Repay Loan" | "Derivative" | null | undefined;
  total: number | null;
};

type ManualTaxTransactionStringField = (typeof manualTaxTransactionStringFields)[number];
type ManualTaxTransactionIntegerField = (typeof manualTaxTransactionIntegerFields)[number];
type NullableStringFieldTarget = Partial<Record<ManualTaxTransactionStringField, string | null>>;
type NullableIntegerFieldTarget = Partial<Record<ManualTaxTransactionIntegerField, number | null>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assignNullableStringField(
  target: NullableStringFieldTarget,
  raw: Record<string, unknown>,
  field: ManualTaxTransactionStringField,
): void {
  if (Object.hasOwn(raw, field)) {
    target[field] = parseNullableString(field, raw[field]);
  }
}

function assignNullableIntegerField(
  target: NullableIntegerFieldTarget,
  raw: Record<string, unknown>,
  field: ManualTaxTransactionIntegerField,
): void {
  if (Object.hasOwn(raw, field)) {
    target[field] = parseNullableInteger(field, raw[field]);
  }
}

function assertValidTaxTransactionLabel(
  label: unknown,
): asserts label is "Trade" | "Transfer" | "Approval" | "Repay Loan" | "Derivative" | null {
  if (
    label !== "Trade" &&
    label !== "Transfer" &&
    label !== "Approval" &&
    label !== "Repay Loan" &&
    label !== "Derivative" &&
    label !== null
  ) {
    throw new ValidationError(
      "label must be Trade, Transfer, Approval, Repay Loan, Derivative, or null",
    );
  }
}

function parseNullableInteger(field: string, value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new ValidationError(`${field} must be a safe integer or null`);
  }
  if (field === "holding_duration_days" && value < 0) {
    throw new ValidationError("holding_duration_days must be non-negative or null");
  }
  return value;
}

function parseNullableString(field: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string or null`);
  }
  return value;
}

function parseString(field: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string`);
  }
  return value;
}

function parseTaxTransactionComment(comment: unknown): string | null {
  if (typeof comment !== "string" && comment !== null) {
    throw new ValidationError("comment must be a string or null");
  }
  if (typeof comment === "string" && comment.length > maxTaxTransactionCommentLength) {
    throw new ValidationError(
      `comment must be at most ${maxTaxTransactionCommentLength} characters`,
    );
  }
  return comment;
}

function parseTaxTransactionUpdateBody(body: unknown): TaxTransactionUpdate {
  if (!isRecord(body)) {
    throw new ValidationError("request body must be an object");
  }

  const update: TaxTransactionUpdate = {};
  for (const key of Object.keys(body)) {
    if (!updatableTaxTransactionFields.has(key)) {
      throw new ValidationError(`unknown field: ${key}`);
    }
  }

  const raw = body;
  if (Object.hasOwn(raw, "hash")) {
    update.hash = parseString("hash", raw.hash);
  }

  for (const field of manualTaxTransactionPatchStringFields) {
    assignNullableStringField(update, raw, field);
  }

  for (const field of manualTaxTransactionIntegerFields) {
    assignNullableIntegerField(update, raw, field);
  }

  if (Object.hasOwn(raw, "label")) {
    assertValidTaxTransactionLabel(raw.label);
    update.label = raw.label;
  }

  if (Object.hasOwn(raw, "comment")) {
    update.comment = parseTaxTransactionComment(raw.comment);
  }

  if (Object.keys(update).length === 0) {
    throw new ValidationError("request body must include at least one editable field");
  }

  return update;
}

function parseManualTaxTransactionBody(body: unknown): ManualTaxTransactionInput {
  if (!isRecord(body)) {
    throw new ValidationError("request body must be an object");
  }

  for (const key of Object.keys(body)) {
    if (!manualTaxTransactionFields.has(key)) {
      throw new ValidationError(`unknown field: ${key}`);
    }
  }

  const raw = body;
  const transaction: ManualTaxTransactionInput = {};

  if (Object.hasOwn(raw, "id")) {
    transaction.id = parseString("id", raw.id);
  }

  if (Object.hasOwn(raw, "hash")) {
    transaction.hash = parseString("hash", raw.hash);
  }

  for (const field of manualTaxTransactionStringFields) {
    assignNullableStringField(transaction, raw, field);
  }

  for (const field of manualTaxTransactionIntegerFields) {
    assignNullableIntegerField(transaction, raw, field);
  }

  if (Object.hasOwn(raw, "label")) {
    assertValidTaxTransactionLabel(raw.label);
    transaction.label = raw.label;
  }

  if (Object.hasOwn(raw, "comment")) {
    transaction.comment = parseTaxTransactionComment(raw.comment);
  }

  return transaction;
}

function manualCreateErrorStatus(err: unknown): { status: 400 | 409; message: string } | null {
  if (!(err instanceof Error)) return null;
  if (err.message === "Manual tax transaction id must contain at least one safe character") {
    return { status: 400, message: err.message };
  }
  if (err.message.startsWith("Manual tax transaction already exists:")) {
    return { status: 409, message: err.message };
  }
  if (err.message.startsWith("Tax transaction label")) {
    return { status: 400, message: err.message };
  }
  return null;
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
    transaction = await Promise.resolve(updateTaxTransaction(id, update));
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "Only manual tax transactions can update ledger properties"
    ) {
      return reply.status(400).send({ error: err.message });
    }
    fastify.log.error(err);
    return reply.status(500).send({ error: "Failed to update tax transaction" });
  }

  if (transaction === null) {
    return reply.status(404).send({ error: "Tax transaction not found", id });
  }

  return { transaction };
}

export async function taxRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/tax/transactions/enrich", async (_request, reply) => {
    try {
      const result = await enrichTaxTransactionsEurValues(fastify.lpConfig);
      return reply.send(result);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(503).send({ error: "Failed to enrich tax transactions" });
    }
  });

  fastify.post("/tax/transactions/sync", async (_request, reply) => {
    try {
      const summary = await syncTaxTransactions(fastify.lpConfig);
      return { sync: summary };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(503).send({ error: "Failed to sync tax transactions" });
    }
  });

  fastify.post("/tax/transactions", async (request, reply) => {
    let input: ManualTaxTransactionInput;
    try {
      input = parseManualTaxTransactionBody(request.body);
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }

    try {
      const transaction = createManualTaxTransaction(input);
      return reply.status(201).send({ transaction });
    } catch (err) {
      const clientError = manualCreateErrorStatus(err);
      if (clientError) {
        return reply.status(clientError.status).send({ error: clientError.message });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: "Failed to create tax transaction" });
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
      let label: "Trade" | "Transfer" | "Approval" | "Repay Loan" | "Derivative" | undefined;
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
      const total = countTaxTransactions(label);
      const pagination: TaxTransactionPagination = {
        limit,
        offset,
        label: label ?? null,
        total,
      };

      return { transactions, pagination };
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
