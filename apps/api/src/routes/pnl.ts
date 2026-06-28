import {
  createClient,
  getPosition,
  getPositionsCacheSyncedAt,
  listCachedPnLViews,
  updateCachedPnLView,
} from "@lp-tracker/core";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import { isNumericString } from "../utils/validation.js";

type CachedPnLView = Record<string, unknown> & {
  tokenId?: unknown;
  openedAt?: unknown;
};

async function backfillOpenedAtIfMissing(
  fastify: FastifyInstance,
  view: CachedPnLView,
): Promise<CachedPnLView> {
  if (typeof view.openedAt === "string" || view.openedAt === null) {
    return view;
  }

  if (typeof view.tokenId !== "string") {
    return view;
  }

  const storedPosition = getPosition(view.tokenId);
  if (storedPosition?.entry_block == null) {
    return view;
  }

  try {
    const client = createClient(fastify.lpConfig);
    const block = await client.getBlock({ blockNumber: BigInt(storedPosition.entry_block) });
    const openedAt = new Date(Number(block.timestamp * 1000n)).toISOString();
    updateCachedPnLView(view.tokenId, { openedAt });
    return { ...view, openedAt };
  } catch {
    return view;
  }
}

async function readCachedPnLViews(fastify: FastifyInstance): Promise<CachedPnLView[]> {
  const cached = listCachedPnLViews() as CachedPnLView[];
  return await Promise.all(cached.map((view) => backfillOpenedAtIfMissing(fastify, view)));
}

export async function pnlRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /pnl — read from cache (no live RPC)
  fastify.get("/pnl", async (_request: FastifyRequest, _reply: FastifyReply) => {
    const positions = await readCachedPnLViews(fastify);
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

      const positions = await readCachedPnLViews(fastify);
      const position = positions.find(
        (view) => typeof view.tokenId === "string" && view.tokenId === tokenId,
      );

      if (!position) {
        return reply.status(404).send({ error: "Position not found", tokenId });
      }

      return { position };
    },
  );
}
