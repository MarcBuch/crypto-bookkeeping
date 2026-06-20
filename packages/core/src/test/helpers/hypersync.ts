import type { Query } from "@envio-dev/hypersync-client";

import type { HypersyncClient, HypersyncQueryResponse } from "../../chain/hypersync.js";

export function makeHypersyncClient(
  get: (query: Query) => Promise<HypersyncQueryResponse>,
): HypersyncClient {
  return { get };
}
