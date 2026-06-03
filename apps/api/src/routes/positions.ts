import { syncLpData, listCachedPositionViews, getPositionsCacheSyncedAt } from "@lp-tracker/core";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import { isNumericString } from "../utils/validation.js";

interface SyncState {
  status: "idle" | "running" | "completed" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  positionCount: number | null;
}

let syncState: SyncState = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  error: null,
  positionCount: null,
};

export async function positionsRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /positions/sync — fire-and-forget; returns 202 immediately
  fastify.post("/positions/sync", async (_request: FastifyRequest, reply: FastifyReply) => {
    if (syncState.status === "running") {
      return reply.status(409).send({ error: "Sync already in progress" });
    }

    const config = fastify.lpConfig;
    syncState = {
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      positionCount: null,
    };

    // Fire and forget — do not await
    syncLpData(config)
      .then((summary) => {
        syncState = {
          status: "completed",
          startedAt: syncState.startedAt,
          finishedAt: new Date().toISOString(),
          error: null,
          positionCount: summary.positionCount,
        };
      })
      .catch((err: unknown) => {
        syncState = {
          status: "failed",
          startedAt: syncState.startedAt,
          finishedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
          positionCount: null,
        };
      });

    return reply.status(202).send({ message: "Sync started" });
  });

  // GET /positions/sync/status — return current sync state
  fastify.get("/positions/sync/status", async (_request: FastifyRequest, _reply: FastifyReply) => {
    return syncState;
  });

  // GET /positions — read from cache (no live RPC)
  fastify.get("/positions", async (_request: FastifyRequest, _reply: FastifyReply) => {
    const positions = listCachedPositionViews();
    const syncedAt = getPositionsCacheSyncedAt();
    return { positions, syncedAt };
  });

  // GET /positions/:tokenId — filter from cache
  fastify.get<{ Params: { tokenId: string } }>(
    "/positions/:tokenId",
    async (request: FastifyRequest<{ Params: { tokenId: string } }>, reply: FastifyReply) => {
      const { tokenId } = request.params;

      if (!isNumericString(tokenId)) {
        return reply.status(400).send({ error: "tokenId must be a numeric string" });
      }

      const positions = listCachedPositionViews();
      const position = positions.find((p) => (p as { tokenId: string }).tokenId === tokenId);

      if (!position) {
        return reply.status(404).send({ error: "Position not found", tokenId });
      }

      return { position };
    },
  );
}
