import { isAddress } from "viem";
import type { Client } from "./client.js";
import { getTokenMetadata, upsertTokenMetadata, type StoredTokenMetadata } from "../db/store.js";

const ERC20_SYMBOL_ABI = [
  { name: "symbol", type: "function", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
] as const;

const ERC20_NAME_ABI = [
  { name: "name", type: "function", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
] as const;

const ERC20_DECIMALS_ABI = [
  { name: "decimals", type: "function", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
] as const;

/** In-flight deduplication: prevents duplicate RPC calls for the same address. */
const inFlight = new Map<string, Promise<StoredTokenMetadata>>();

export async function resolveTokenMetadata(
  client: Client,
  contractAddress: string,
): Promise<StoredTokenMetadata> {
  const address = contractAddress.toLowerCase();

  // Check DB cache first — no RPC call needed
  const cached = getTokenMetadata(address);
  if (cached) {
    return cached;
  }

  // Deduplicate concurrent requests for the same address
  const existing = inFlight.get(address);
  if (existing) {
    return existing;
  }

  const promise = fetchAndCache(client, address);
  inFlight.set(address, promise);

  try {
    return await promise;
  } finally {
    inFlight.delete(address);
  }
}

async function fetchAndCache(client: Client, address: string): Promise<StoredTokenMetadata> {
  if (!isAddress(address)) {
    throw new Error(`resolveTokenMetadata: invalid contract address: ${address}`);
  }
  const addr = address as `0x${string}`;

  // Fetch all three in parallel — each failure stores null for that field
  const [symResult, nameResult, decResult] = await Promise.allSettled([
    client.readContract({ address: addr, abi: ERC20_SYMBOL_ABI, functionName: "symbol" }),
    client.readContract({ address: addr, abi: ERC20_NAME_ABI, functionName: "name" }),
    client.readContract({ address: addr, abi: ERC20_DECIMALS_ABI, functionName: "decimals" }),
  ]);

  const symbol = symResult.status === "fulfilled" ? (symResult.value as string) : null;
  const name = nameResult.status === "fulfilled" ? (nameResult.value as string) : null;
  const decimals = decResult.status === "fulfilled" ? (decResult.value as number) : null;

  const metadata: StoredTokenMetadata = {
    contract_address: address,
    symbol,
    name,
    decimals,
    fetched_at: new Date().toISOString(),
  };

  upsertTokenMetadata(metadata);

  return metadata;
}
