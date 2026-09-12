import { createPublicClient, defineChain, custom } from "viem";

import type { Config } from "../config";
import { isRecord } from "../utils/guards.js";
import { rateLimit } from "./rpc.js";

// Both the Hyperliquid public RPC and Envio HyperRPC use certificates that
// Bun's bundled CA store does not recognise. Disable verification only for
// this process (a CLI tool, not a server). This was present in the original
// code; keeping it here makes the behaviour explicit rather than hidden.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

export const hyperEvm = defineChain({
  id: 999,
  name: "HyperEVM",
  nativeCurrency: {
    name: "HYPE",
    symbol: "HYPE",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://hyperliquid.rpc.hypersync.xyz"],
    },
  },
  blockExplorers: {
    default: {
      name: "HyperEVM Explorer",
      url: "https://hyperevmscan.io",
    },
  },
});

const TRANSPORT_TIMEOUT = 30_000;

// Methods supported by Envio HyperRPC. All others (eth_call, etc.) must go
// to a full node. See https://docs.envio.dev/docs/HyperRPC/overview-hyperrpc
const HYPER_RPC_METHODS = new Set(["eth_getLogs", "eth_getTransactionReceipt"]);

export type RpcResponse = {
  result?: unknown;
  error?: { code: number; message: string };
};

export function parseRpcResponse(value: unknown): RpcResponse {
  if (!isRecord(value)) return {};

  // Some gateways (e.g. an Envio HyperRPC endpoint rejecting the API token)
  // return a bare string error: {"error": "Your token does not have access..."}.
  // Surface it like a JSON-RPC error so callers fail loudly instead of reading
  // `undefined` as a successful (empty) result.
  const error = isRecord(value.error)
    ? {
        code: typeof value.error.code === "number" ? value.error.code : 0,
        message:
          typeof value.error.message === "string" ? value.error.message : "Unknown RPC error",
      }
    : typeof value.error === "string"
      ? { code: 0, message: value.error }
      : undefined;

  return {
    result: value.result,
    error,
  };
}

const MAX_ERROR_BODY_CHARS = 200;

/** Best-effort short body excerpt for error messages (never throws). */
async function readBodyExcerpt(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text.length > MAX_ERROR_BODY_CHARS ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}…` : text;
  } catch {
    return "";
  }
}

/** Parse a Retry-After header (integer seconds or HTTP-date) as milliseconds. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * 1000 : undefined;
  }

  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return undefined;
}

export async function fetchRpc(
  url: string,
  method: string,
  params: unknown,
  minIntervalMs = 0,
): Promise<unknown> {
  // Pace the actual request per endpoint before starting the timeout clock.
  if (minIntervalMs > 0) {
    await rateLimit(url, minIntervalMs);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TRANSPORT_TIMEOUT);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const excerpt = await readBodyExcerpt(response);
      const statusText = response.statusText ? ` ${response.statusText}` : "";
      const error = Object.assign(
        new Error(`RPC request failed with HTTP ${response.status}${statusText}: ${excerpt}`),
        {
          code: 0,
          details: excerpt,
          status: response.status,
          retryAfterMs: undefined as number | undefined,
        },
      );
      if (response.status === 429) {
        // Align with the transport's rate-limit convention so withRetry retries.
        error.code = -32005;
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        if (retryAfterMs !== undefined) {
          error.retryAfterMs = retryAfterMs;
        }
      }
      throw error;
    }

    const data = parseRpcResponse(await response.json());

    if (data.error) {
      const err = Object.assign(new Error(data.error.message), {
        code: data.error.code,
        details: data.error.message,
      });
      err.code = data.error.code;
      err.details = data.error.message;
      throw err;
    }

    return data.result;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      const timeout = Object.assign(
        new Error(`RPC request timed out after ${TRANSPORT_TIMEOUT}ms`),
        { code: -32099 },
      );
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Routed transport: sends eth_getLogs and eth_getTransactionReceipt to the
 * logs endpoint (config.logsRpc ?? config.rpc) and all other methods
 * (eth_call, etc.) to the standard full-node RPC (config.rpc). Falls back to
 * config.rpc for both if config.logsRpc is not set. Note that with Hypersync
 * configured, eth_getLogs rarely uses this path — Hypersync handles log scans
 * via the SDK; this transport still serves any viem getLogs fallback.
 *
 * Each endpoint is paced independently: the main RPC defaults to 50ms between
 * requests (the historical public-node value) and the logs endpoint to 10ms
 * (the historical HyperRPC value), overridable via config.
 */
function createRoutedTransport(
  config: Pick<Config, "rpc" | "logsRpc" | "rpcMinIntervalMs" | "logsRpcMinIntervalMs">,
) {
  const logsUrl = config.logsRpc ?? config.rpc;
  const callUrl = config.rpc;
  const callIntervalMs = config.rpcMinIntervalMs ?? 50;
  // When logsRpc is unset, both endpoints target the same RPC URL. Pacing must
  // then be per-URL, not per logical endpoint, so use the main-RPC interval.
  const logsIntervalMs =
    logsUrl === callUrl ? callIntervalMs : (config.logsRpcMinIntervalMs ?? 10);

  return custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        const useLogsEndpoint = HYPER_RPC_METHODS.has(method);
        const url = useLogsEndpoint ? logsUrl : callUrl;
        const minIntervalMs = useLogsEndpoint ? logsIntervalMs : callIntervalMs;
        return fetchRpc(url, method, params ?? [], minIntervalMs);
      },
    },
    { retryCount: 0 }, // retries are handled by withRetry() in rpc.ts
  );
}

export function createClient(
  config: Pick<Config, "rpc" | "logsRpc" | "rpcMinIntervalMs" | "logsRpcMinIntervalMs">,
) {
  return createPublicClient({
    chain: hyperEvm,
    transport: createRoutedTransport(config),
  });
}

export type Client = ReturnType<typeof createClient>;
