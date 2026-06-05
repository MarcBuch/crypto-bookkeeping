import { createPublicClient, defineChain, custom } from "viem";

import type { Config } from "../config";

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
const HYPER_RPC_METHODS = new Set([
  "eth_getLogs",
  "eth_getTransactionReceipt",
]);

async function fetchRpc(url: string, method: string, params: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TRANSPORT_TIMEOUT);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });

    const data = (await response.json()) as {
      result?: unknown;
      error?: { code: number; message: string };
    };

    if (data.error) {
      const err = new Error(data.error.message) as Error & { code: number; details: string };
      err.code = data.error.code;
      err.details = data.error.message;
      throw err;
    }

    return data.result;
  } catch (err: any) {
    if (err.name === "AbortError") {
      const timeout = new Error(
        `RPC request timed out after ${TRANSPORT_TIMEOUT}ms`,
      ) as Error & { code: number };
      timeout.code = -32099;
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Routed transport: sends eth_getLogs and eth_getTransactionReceipt to
 * Envio HyperRPC (config.logsRpc) for large block-range support, and all
 * other methods (eth_call, etc.) to the standard full-node RPC (config.rpc).
 * Falls back to config.rpc for both if config.logsRpc is not set.
 */
function createRoutedTransport(config: Config) {
  const logsUrl = config.logsRpc ?? config.rpc;
  const callUrl = config.rpc;

  return custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        const url = HYPER_RPC_METHODS.has(method) ? logsUrl : callUrl;
        return fetchRpc(url, method, params ?? []);
      },
    },
    { retryCount: 0 }, // retries are handled by withRetry() in rpc.ts
  );
}

export function createClient(config: Config) {
  return createPublicClient({
    chain: hyperEvm,
    transport: createRoutedTransport(config),
  });
}

export type Client = ReturnType<typeof createClient>;
