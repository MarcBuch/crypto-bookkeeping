import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

import { loadConfig, resolveConfigPath } from "../config.js";

const TMP = join(import.meta.dir, "../../.test-tmp/lp-tracker-config-tests");

function tmpFile(name: string): string {
  return join(TMP, name);
}

function writeConfig(name: string, content: string): string {
  const path = tmpFile(name);
  writeFileSync(path, content, "utf-8");
  return path;
}

function validConfigJson(): string {
  return JSON.stringify({
    rpc: "https://rpc.example.com",
    chainId: 999,
    wallet: "0xCBB12c1D36A4C599a1B63aB76F508A179ca1F34d",
    contracts: {
      factory: "0xFf7B3e8C00e57ea31477c32A5B52a58Eea47b072",
      positionManager: "0xeaD19AE861c29bBb2101E834922B2FEee69B9091",
      quoter: "0x239F11a7A3E08f2B8110D4CA9F6B95d4c8865258",
      swapRouter: "0x1EbDFC75FfE3ba3de61E7138a3E8706aC841Af9B",
    },
  });
}

describe("loadConfig — adversarial tests", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    delete process.env.LP_TRACKER_CONFIG;
  });

  afterEach(() => {
    delete process.env.LP_TRACKER_CONFIG;
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  // ── Happy path ────────────────────────────────────────────────────────────
  it("loads a valid config via explicit path", () => {
    const path = writeConfig("valid.json", validConfigJson());
    const cfg = loadConfig(path);
    expect(cfg.rpc).toBe("https://rpc.example.com");
    expect(cfg.chainId).toBe(999);
    expect(cfg.wallet).toBe("0xCBB12c1D36A4C599a1B63aB76F508A179ca1F34d");
  });

  it("loads a valid config via LP_TRACKER_CONFIG env var", () => {
    const path = writeConfig("env-config.json", validConfigJson());
    process.env.LP_TRACKER_CONFIG = path;
    const cfg = loadConfig();
    expect(cfg.rpc).toBe("https://rpc.example.com");
  });

  it("includes optional positions map when present", () => {
    const content = JSON.stringify({
      ...JSON.parse(validConfigJson()),
      positions: { "123": { openTx: "0xabc" } },
    });
    const path = writeConfig("with-positions.json", content);
    const cfg = loadConfig(path);
    expect(cfg.positions?.["123"]?.openTx).toBe("0xabc");
  });

  // ── Missing file ──────────────────────────────────────────────────────────
  it("throws a clear error when config file does not exist", () => {
    expect(() => loadConfig(tmpFile("does-not-exist.json"))).toThrow(/Config file not found/);
  });

  it("throws when LP_TRACKER_CONFIG points to a non-existent file", () => {
    process.env.LP_TRACKER_CONFIG = tmpFile("ghost.json");
    expect(() => loadConfig()).toThrow(/Config file not found/);
  });

  // ── Malformed JSON ────────────────────────────────────────────────────────
  it("throws a clear error for malformed JSON", () => {
    const path = writeConfig("bad.json", "{ not valid json }");
    expect(() => loadConfig(path)).toThrow(/not valid JSON/);
  });

  it("throws for empty file", () => {
    const path = writeConfig("empty.json", "");
    expect(() => loadConfig(path)).toThrow(/not valid JSON/);
  });

  it("throws for JSON array instead of object", () => {
    const path = writeConfig("array.json", "[1, 2, 3]");
    expect(() => loadConfig(path)).toThrow(/must be a JSON object/);
  });

  it("throws for JSON null", () => {
    const path = writeConfig("null.json", "null");
    expect(() => loadConfig(path)).toThrow(/must be a JSON object/);
  });

  // ── Missing required top-level fields ─────────────────────────────────────
  it("throws when 'rpc' is missing", () => {
    const rest = JSON.parse(validConfigJson());
    delete rest.rpc;
    const path = writeConfig("no-rpc.json", JSON.stringify(rest));
    expect(() => loadConfig(path)).toThrow(/"rpc"/);
  });

  it("throws when 'wallet' is missing", () => {
    const rest = JSON.parse(validConfigJson());
    delete rest.wallet;
    const path = writeConfig("no-wallet.json", JSON.stringify(rest));
    expect(() => loadConfig(path)).toThrow(/"wallet"/);
  });

  it("throws when 'contracts' is missing", () => {
    const rest = JSON.parse(validConfigJson());
    delete rest.contracts;
    const path = writeConfig("no-contracts.json", JSON.stringify(rest));
    expect(() => loadConfig(path)).toThrow(/"contracts"/);
  });

  it("throws when 'chainId' is missing", () => {
    const rest = JSON.parse(validConfigJson());
    delete rest.chainId;
    const path = writeConfig("no-chainid.json", JSON.stringify(rest));
    expect(() => loadConfig(path)).toThrow(/"chainId"/);
  });

  // ── Missing required contract addresses ────────────────────────────────────
  it("throws when contracts.positionManager is missing", () => {
    const cfg = JSON.parse(validConfigJson());
    delete cfg.contracts.positionManager;
    const path = writeConfig("no-pm.json", JSON.stringify(cfg));
    expect(() => loadConfig(path)).toThrow(/contracts\.positionManager/);
  });

  it("throws when contracts.factory is missing", () => {
    const cfg = JSON.parse(validConfigJson());
    delete cfg.contracts.factory;
    const path = writeConfig("no-factory.json", JSON.stringify(cfg));
    expect(() => loadConfig(path)).toThrow(/contracts\.factory/);
  });

  it("throws when contracts is a non-object value", () => {
    const cfg = JSON.parse(validConfigJson());
    cfg.contracts = "not-an-object";
    const path = writeConfig("bad-contracts.json", JSON.stringify(cfg));
    expect(() => loadConfig(path)).toThrow(/"contracts" must be an object/);
  });

  // ── logsFromBlock validation ──────────────────────────────────────────────
  describe("logsFromBlock validation", () => {
    function withLogsFromBlock(value: unknown): string {
      // Build the JSON manually so we can inject raw values (including a JSON
      // string in the number's place) that survive the round-trip through JSON.
      return JSON.stringify({
        ...JSON.parse(validConfigJson()),
        logsFromBlock: value,
      });
    }

    it("throws when logsFromBlock is negative (-1)", () => {
      const path = writeConfig("lfb-negative.json", withLogsFromBlock(-1));
      expect(() => loadConfig(path)).toThrow(/"logsFromBlock" must be a positive integer/);
    });

    it("throws when logsFromBlock is zero", () => {
      const path = writeConfig("lfb-zero.json", withLogsFromBlock(0));
      expect(() => loadConfig(path)).toThrow(/"logsFromBlock" must be a positive integer/);
    });

    it("throws when logsFromBlock is a non-integer (1.5)", () => {
      const path = writeConfig("lfb-float.json", withLogsFromBlock(1.5));
      expect(() => loadConfig(path)).toThrow(/"logsFromBlock" must be a positive integer/);
    });

    it("throws when logsFromBlock is a string", () => {
      const path = writeConfig("lfb-string.json", withLogsFromBlock("1000000"));
      expect(() => loadConfig(path)).toThrow(/"logsFromBlock" must be a positive integer/);
    });

    it("does NOT throw when logsFromBlock is null (treated as omitted)", () => {
      const path = writeConfig("lfb-null.json", withLogsFromBlock(null));
      const cfg = loadConfig(path);
      expect(cfg.logsFromBlock).toBeNull();
    });

    it("does NOT throw when logsFromBlock is omitted entirely", () => {
      const path = writeConfig("lfb-omitted.json", validConfigJson());
      const cfg = loadConfig(path);
      expect(cfg.logsFromBlock).toBeUndefined();
    });

    it("loads a valid positive integer and preserves it (2592000)", () => {
      const path = writeConfig("lfb-valid.json", withLogsFromBlock(2592000));
      const cfg = loadConfig(path);
      expect(cfg.logsFromBlock).toBe(2592000);
    });
  });

  describe("tax.hyperSyncUrl and tax.hyperSyncApiToken validation", () => {
    // ── Happy path ────────────────────────────────────────────────────────────

    it("loads without error when no 'tax' field is present", () => {
      const path = writeConfig("tax-absent.json", validConfigJson());
      const cfg = loadConfig(path);
      expect(cfg.tax).toBeUndefined();
    });

    it("loads without error when tax is an empty object", () => {
      const content = JSON.stringify({
        ...JSON.parse(validConfigJson()),
        tax: {},
      });
      const path = writeConfig("tax-empty.json", content);
      const cfg = loadConfig(path);
      expect(cfg.tax).toEqual({});
    });

    it("loads with valid hyperSyncUrl and makes it accessible", () => {
      const content = JSON.stringify({
        ...JSON.parse(validConfigJson()),
        tax: { hyperSyncUrl: "https://hyperliquid.hypersync.xyz" },
      });
      const path = writeConfig("tax-hypersync-url.json", content);
      const cfg = loadConfig(path);
      expect(cfg.tax?.hyperSyncUrl).toBe("https://hyperliquid.hypersync.xyz");
    });

    it("loads with valid hyperSyncApiToken and makes it accessible", () => {
      const content = JSON.stringify({
        ...JSON.parse(validConfigJson()),
        tax: { hyperSyncApiToken: "my-token" },
      });
      const path = writeConfig("tax-hypersync-token.json", content);
      const cfg = loadConfig(path);
      expect(cfg.tax?.hyperSyncApiToken).toBe("my-token");
    });

    it("loads without error when only old explorerApiUrl is present (backward compat)", () => {
      const content = JSON.stringify({
        ...JSON.parse(validConfigJson()),
        tax: { explorerApiUrl: "https://explorer.example.com/api" },
      });
      const path = writeConfig("tax-explorer-only.json", content);
      const cfg = loadConfig(path);
      expect(cfg.tax?.explorerApiUrl).toBe("https://explorer.example.com/api");
    });

    it("loads without error when both hyperSyncUrl and explorerApiUrl are present", () => {
      const content = JSON.stringify({
        ...JSON.parse(validConfigJson()),
        tax: {
          hyperSyncUrl: "https://hyperliquid.hypersync.xyz",
          explorerApiUrl: "https://explorer.example.com/api",
        },
      });
      const path = writeConfig("tax-both-urls.json", content);
      const cfg = loadConfig(path);
      expect(cfg.tax?.hyperSyncUrl).toBe("https://hyperliquid.hypersync.xyz");
      expect(cfg.tax?.explorerApiUrl).toBe("https://explorer.example.com/api");
    });

    it("loads without error when hyperSyncApiToken is an empty string (treated as absent)", () => {
      const content = JSON.stringify({
        ...JSON.parse(validConfigJson()),
        tax: { hyperSyncApiToken: "" },
      });
      const path = writeConfig("tax-empty-token.json", content);
      const cfg = loadConfig(path);
      expect(cfg.tax?.hyperSyncApiToken).toBe("");
    });

    // ── Validation errors ─────────────────────────────────────────────────────

    it("throws when hyperSyncUrl is not a valid URL", () => {
      const content = JSON.stringify({
        ...JSON.parse(validConfigJson()),
        tax: { hyperSyncUrl: "not-a-url" },
      });
      const path = writeConfig("tax-bad-url.json", content);
      expect(() => loadConfig(path)).toThrow(/"tax.hyperSyncUrl" must be a valid URL/);
    });

    it("throws when hyperSyncUrl is an empty string", () => {
      const content = JSON.stringify({
        ...JSON.parse(validConfigJson()),
        tax: { hyperSyncUrl: "" },
      });
      const path = writeConfig("tax-empty-url.json", content);
      expect(() => loadConfig(path)).toThrow(/"tax.hyperSyncUrl" must be a non-empty string/);
    });

    it("throws when hyperSyncUrl is a number", () => {
      const content = JSON.stringify({
        ...JSON.parse(validConfigJson()),
        tax: { hyperSyncUrl: 123 },
      });
      const path = writeConfig("tax-numeric-url.json", content);
      expect(() => loadConfig(path)).toThrow(/"tax.hyperSyncUrl" must be a non-empty string/);
    });

    it("throws when hyperSyncApiToken is a number", () => {
      const content = JSON.stringify({
        ...JSON.parse(validConfigJson()),
        tax: { hyperSyncApiToken: 42 },
      });
      const path = writeConfig("tax-numeric-token.json", content);
      expect(() => loadConfig(path)).toThrow(/"tax.hyperSyncApiToken" must be a string/);
    });
  });
});

describe("resolveConfigPath — env override", () => {
  afterEach(() => {
    delete process.env.LP_TRACKER_CONFIG;
  });

  it("returns the env var path when set (absolute)", () => {
    process.env.LP_TRACKER_CONFIG = "/absolute/path/to/config.json";
    expect(resolveConfigPath()).toBe("/absolute/path/to/config.json");
  });

  it("returns a string when env var is not set (falls back to cwd or repo root)", () => {
    delete process.env.LP_TRACKER_CONFIG;
    const result = resolveConfigPath();
    expect(typeof result).toBe("string");
    expect(result.endsWith("config.json")).toBe(true);
  });
});
