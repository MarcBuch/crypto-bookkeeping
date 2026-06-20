import { isRecord } from "../../utils/guards.js";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

export function getRequestUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function setFetchMock(
  handler: (input: FetchInput, init: FetchInit) => Response | Promise<Response>,
): void {
  const fetchMock = Object.assign(
    async (input: FetchInput, init?: FetchInit) => handler(input, init),
    globalThis.fetch,
  ) satisfies typeof globalThis.fetch;
  globalThis.fetch = fetchMock;
}

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: init.headers,
  });
}

export function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

export function parseJsonRequestBody(init?: RequestInit): unknown {
  if (typeof init?.body !== "string") {
    return undefined;
  }

  return JSON.parse(init.body);
}

export function getRequestType(init?: RequestInit): string | null {
  const body = parseJsonRequestBody(init);
  return isRecord(body) && typeof body.type === "string" ? body.type : null;
}
