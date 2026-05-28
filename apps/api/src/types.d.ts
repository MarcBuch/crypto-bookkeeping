import type { Config } from "@lp-tracker/core";

declare module "fastify" {
  interface FastifyInstance {
    lpConfig: Config;
  }
}
