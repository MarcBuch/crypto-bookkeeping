import { createPublicClient, http, defineChain } from "viem";
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

export function createClient(config: Config) {
  return createPublicClient({
    chain: hyperEvm,
    transport: http(config.rpc, {
      timeout: 30_000, // 30s — prevents hung requests stalling the process
      retryCount: 0,   // retries handled by withRetry in rpc.ts
    }),
  });
}

export type Client = ReturnType<typeof createClient>;
