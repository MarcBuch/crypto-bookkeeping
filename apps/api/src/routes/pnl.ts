import {
  createClient,
  getPosition,
  getPnLView,
  getPositionsCacheSyncedAt,
  listCachedPnLViews,
  mergeCachedUsdFields,
  updateCachedPnLView,
} from "@lp-tracker/core";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import { isNumericString } from "../utils/validation.js";

type CachedPnLView = Record<string, unknown> & {
  tokenId?: unknown;
  openedAt?: unknown;
};

const requiredUsdAccountingFields = [
  "entryToken0UsdPrice",
  "entryToken1UsdPrice",
  "entryValueUsd",
  "pendingFeesValueUsd",
  "pnlUsd",
  "pnlUsdCompleteness",
  "pnlUsdSource",
] as const;

function needsUsdAccountingHydration(view: CachedPnLView): boolean {
  return requiredUsdAccountingFields.some((field) => !(field in view) || view[field] == null);
}

async function hydrateUsdAccountingIfMissing(
  fastify: FastifyInstance,
  view: CachedPnLView,
): Promise<CachedPnLView> {
  if (!needsUsdAccountingHydration(view) || typeof view.tokenId !== "string") return view;

  try {
    const recomputed = await getPnLView(fastify.lpConfig, view.tokenId);
    const fresh = recomputed.find((row) => row.tokenId === view.tokenId);
    if (!fresh) return view;
    const merged = mergeCachedUsdFields(fresh, view) as unknown as CachedPnLView;
    updateCachedPnLView(view.tokenId, merged);
    return merged;
  } catch {
    // A pricing/RPC outage must not erase a previously valid cached snapshot.
    return view;
  }
}

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
  return await Promise.all(
    cached.map(async (view) => {
      const hydrated = await hydrateUsdAccountingIfMissing(fastify, view);
      return backfillOpenedAtIfMissing(fastify, hydrated);
    }),
  );
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
