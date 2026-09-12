import { afterEach, describe, expect, it } from "bun:test";

import { fetchRpc, parseRpcResponse } from "../chain/client.js";
import { withRetry } from "../chain/rpc.js";
import { captureError, expectError } from "./helpers/errors.js";
import { jsonResponse, setFetchMock } from "./helpers/http.js";

const originalFetch = globalThis.fetch;
const RPC_URL = "https://rpc.example.com/evm";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function bodyExcerpt(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

describe("parseRpcResponse — bare string errors", () => {
  it("maps a bare string error to code 0 with that message", () => {
    expect(parseRpcResponse({ error: "Your token does not have access to this product" })).toEqual({
      result: undefined,
      error: { code: 0, message: "Your token does not have access to this product" },
    });
  });

  it("still parses JSON-RPC object errors", () => {
    expect(parseRpcResponse({ error: { code: -32601, message: "Method not found" } })).toEqual({
      result: undefined,
      error: { code: -32601, message: "Method not found" },
    });
  });
});

describe("fetchRpc — error surfacing", () => {
  it("throws the bare-string error message instead of returning undefined", async () => {
    const message = "Your token does not have access to this product...";
    setFetchMock(async () => jsonResponse({ error: message }));

    const err = expectError(await captureError(fetchRpc(RPC_URL, "eth_getTransactionReceipt", [])));

    expect(err.message).toBe(message);
  });

  it("marks HTTP 429 as a rate-limit error and parses Retry-After seconds", async () => {
    setFetchMock(
      async () =>
        new Response("slow down", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "1" },
        }),
    );

    const err: any = await captureError(fetchRpc(RPC_URL, "eth_call", []));

    expect(err.code).toBe(-32005);
    expect(err.retryAfterMs).toBe(1000);
    expect(err.message).toContain("429");
  });

  it("withRetry retries a 429 and succeeds once the endpoint recovers", async () => {
    let calls = 0;
    setFetchMock(async () => {
      calls++;
      if (calls === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
      }
      return jsonResponse({ result: "0x1234" });
    });

    const result = await withRetry(
      () => fetchRpc(RPC_URL, "eth_call", []),
      3,
      1,
      30_000,
    );

    expect(result).toBe("0x1234");
    expect(calls).toBe(2);
  });

  it("throws status + body excerpt on HTTP 500 and does not retry", async () => {
    const body = JSON.stringify({ error: { code: -32000, message: "internal boom" } });
    let calls = 0;
    setFetchMock(async () => {
      calls++;
      return jsonResponse(JSON.parse(body), { status: 500, statusText: "Internal Server Error" });
    });

    const err = expectError(
      await captureError(withRetry(() => fetchRpc(RPC_URL, "eth_call", []), 3, 1, 10)),
    );

    expect(err.message).toContain("500");
    expect(err.message).toContain("internal boom");
    expect(err.message).toContain(bodyExcerpt(body));
    expect(calls).toBe(1); // non-rate-limit errors are not retried
  });
});
