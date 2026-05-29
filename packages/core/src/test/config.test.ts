import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

import { loadConfig, resolveConfigPath } from "../config.js";

const TMP = "/var/folders/bv/cfnpmk5j1l105w6mjddhgbfw0000gp/T/opencode/lp-tracker-config-tests";

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
