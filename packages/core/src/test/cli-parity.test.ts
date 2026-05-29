/**
 * m2t5 — Adversarial tests: CLI parity
 *
 * Tests error classes, display helpers, and the isJsonMode logic without
 * invoking the CLI binary (which would require a live chain connection).
 *
 * Approach:
 *   - Error class tests: pure structural checks (instanceof, .name, .message, .code)
 *   - Display helper tests: pure functions from display/table.ts
 *   - isJsonMode logic: replicated inline (the function itself is not exported)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { NotFoundError, RpcError } from "../services/errors.js";
import { formatNumber, formatPrice, formatPercent } from "../display/table.js";

// ───────────────────────────────────────────────────────────────────────────
// 1. isJsonMode() — simulated via process.argv manipulation
// ───────────────────────────────────────────────────────────────────────────

describe("isJsonMode — process.argv logic", () => {
  // The CLI's isJsonMode() is: process.argv.includes("--json")
  // We replicate that exact logic here to test it in isolation.
  function isJsonMode(): boolean {
    return process.argv.includes("--json");
  }

  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = [...process.argv];
  });

  afterEach(() => {
    process.argv.length = 0;
    process.argv.push(...originalArgv);
  });

  it("returns false when --json is not in argv", () => {
    process.argv = ["node", "lp-tracker", "il"];
    expect(isJsonMode()).toBe(false);
  });

  it("returns true when --json is in argv", () => {
    process.argv = ["node", "lp-tracker", "il", "--json"];
    expect(isJsonMode()).toBe(true);
  });

  it("returns true when --json appears anywhere in argv", () => {
    process.argv = ["node", "--json", "lp-tracker", "pnl"];
    expect(isJsonMode()).toBe(true);
  });

  it("returns false for --JSON (case-sensitive)", () => {
    process.argv = ["node", "lp-tracker", "--JSON"];
    expect(isJsonMode()).toBe(false);
  });

  it("returns false for --json= with value", () => {
    process.argv = ["node", "lp-tracker", "--json=true"];
    expect(isJsonMode()).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. NotFoundError — surfaces as readable message, not stack trace
// ───────────────────────────────────────────────────────────────────────────

describe("NotFoundError — error class contract", () => {
  it("has .name === 'NotFoundError'", () => {
    const err = new NotFoundError("Position #42 not found.");
    expect(err.name).toBe("NotFoundError");
  });

  it("has .message accessible without stack trace leaking", () => {
    const err = new NotFoundError("Position #42 not found.");
    expect(err.message).toBe("Position #42 not found.");
    // The message must not contain a stack trace snippet
    expect(err.message).not.toContain("at ");
    expect(err.message).not.toContain("Error:");
  });

  it("is instanceof Error", () => {
    const err = new NotFoundError("something missing");
    expect(err instanceof Error).toBe(true);
  });

  it("is instanceof NotFoundError", () => {
    const err = new NotFoundError("something missing");
    expect(err instanceof NotFoundError).toBe(true);
  });

  it("can be caught and checked with instanceof in CLI catch block pattern", () => {
    let caughtMessage = "";
    try {
      throw new NotFoundError("Position #99 not found.");
    } catch (err) {
      if (err instanceof NotFoundError) {
        caughtMessage = err.message;
      }
    }
    expect(caughtMessage).toBe("Position #99 not found.");
  });

  it("stack is present (Error superclass functionality)", () => {
    const err = new NotFoundError("test");
    // Stack must exist but the .message property must not contain it
    expect(err.stack).toBeDefined();
    expect(typeof err.stack).toBe("string");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. RpcError — exposes code field
// ───────────────────────────────────────────────────────────────────────────

describe("RpcError — error class contract", () => {
  it("has .code === -32005 when constructed with that code", () => {
    const err = new RpcError("rate limited", -32005);
    expect(err.code).toBe(-32005);
  });

  it("has .name === 'RpcError'", () => {
    const err = new RpcError("connection refused", -32001);
    expect(err.name).toBe("RpcError");
  });

  it("is instanceof Error", () => {
    const err = new RpcError("rpc error", -32000);
    expect(err instanceof Error).toBe(true);
  });

  it("is instanceof RpcError", () => {
    const err = new RpcError("rpc error", -32000);
    expect(err instanceof RpcError).toBe(true);
  });

  it(".message is accessible", () => {
    const err = new RpcError("server overloaded", -32005);
    expect(err.message).toBe("server overloaded");
  });

  it(".code is undefined when not provided", () => {
    const err = new RpcError("unknown error");
    expect(err.code).toBeUndefined();
  });

  it("code is readonly (TypeScript structural check — value does not change)", () => {
    const err = new RpcError("test", -32005);
    // We can't reassign a readonly property in TS but at runtime we verify
    // the value hasn't been accidentally mutated by the constructor
    expect(err.code).toBe(-32005);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Error classes are instanceof Error (explicit)
// ───────────────────────────────────────────────────────────────────────────

describe("Error hierarchy — both error classes extend Error", () => {
  it("NotFoundError instanceof Error", () => {
    expect(new NotFoundError("x") instanceof Error).toBe(true);
  });

  it("RpcError instanceof Error", () => {
    expect(new RpcError("x") instanceof Error).toBe(true);
  });

  it("NotFoundError is NOT instanceof RpcError", () => {
    expect(new NotFoundError("x") instanceof RpcError).toBe(false);
  });

  it("RpcError is NOT instanceof NotFoundError", () => {
    expect(new RpcError("x") instanceof NotFoundError).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. formatPrice — handles edge cases without throwing
// ───────────────────────────────────────────────────────────────────────────

describe("formatPrice — edge cases", () => {
  it("formatPrice(0) returns '0'", () => {
    expect(formatPrice(0)).toBe("0");
  });

  it("formatPrice(0) does not throw", () => {
    expect(() => formatPrice(0)).not.toThrow();
  });

  it("formatPrice with very small number (below 0.001) returns exponential notation", () => {
    const result = formatPrice(0.0000001);
    expect(typeof result).toBe("string");
    expect(result).toContain("e");
  });

  it("formatPrice with large number (> 1000) returns 2 decimal places", () => {
    const result = formatPrice(50000);
    expect(result).toBe("50000.00");
  });

  it("formatPrice with number between 1 and 1000 returns 4 decimal places", () => {
    const result = formatPrice(1.5);
    expect(result).toBe("1.5000");
  });

  it("formatPrice with NaN does not throw", () => {
    // NaN comparisons in JS: NaN > 1000 → false, NaN > 1 → false, etc.
    // Will fall through to toExponential which handles NaN.
    expect(() => formatPrice(NaN)).not.toThrow();
  });

  it("formatPrice with Infinity does not throw", () => {
    expect(() => formatPrice(Infinity)).not.toThrow();
  });

  it("formatPrice with negative number does not throw", () => {
    expect(() => formatPrice(-100)).not.toThrow();
  });

  it("formatPrice returns a string for any finite number", () => {
    const inputs = [0, 0.001, 0.5, 1.0, 100, 1000.5, 99999];
    for (const n of inputs) {
      expect(typeof formatPrice(n)).toBe("string");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6. formatNumber — handles edge cases
// ───────────────────────────────────────────────────────────────────────────

describe("formatNumber — edge cases", () => {
  it("formatNumber(0) does not throw", () => {
    expect(() => formatNumber(0)).not.toThrow();
  });

  it("formatNumber(0) returns '0'", () => {
    expect(formatNumber(0)).toBe("0");
  });

  it("formatNumber(NaN) does not throw", () => {
    expect(() => formatNumber(NaN)).not.toThrow();
  });

  it("formatNumber(NaN) returns a string", () => {
    const result = formatNumber(NaN);
    expect(typeof result).toBe("string");
  });

  it("formatNumber(Infinity) does not throw", () => {
    expect(() => formatNumber(Infinity)).not.toThrow();
  });

  it("formatNumber(Infinity) returns a string", () => {
    const result = formatNumber(Infinity);
    expect(typeof result).toBe("string");
  });

  it("formatNumber(-Infinity) does not throw", () => {
    expect(() => formatNumber(-Infinity)).not.toThrow();
  });

  it("formatNumber with very small value (< 0.000001) returns '0'", () => {
    // Per implementation: if Math.abs(n) < 0.000001, return "0"
    expect(formatNumber(0.0000005)).toBe("0");
    expect(formatNumber(-0.0000005)).toBe("0");
  });

  it("formatNumber with large number uses locale string (no decimal overflow)", () => {
    const result = formatNumber(2_000_000);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("formatNumber with custom decimals parameter", () => {
    const result = formatNumber(1.23456789, 2);
    expect(result).toBe("1.23");
  });

  it("formatNumber with realistic LP amounts", () => {
    // Typical amounts for WBTC (0.5 BTC, 14000 USDC, 0.001 fee)
    expect(() => formatNumber(0.5, 4)).not.toThrow();
    expect(() => formatNumber(14000, 2)).not.toThrow();
    expect(() => formatNumber(0.001, 6)).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Bonus: formatPercent — used in CLI output for price change display
// ───────────────────────────────────────────────────────────────────────────

describe("formatPercent — edge cases", () => {
  it("formatPercent(0) does not throw", () => {
    expect(() => formatPercent(0)).not.toThrow();
  });

  it("formatPercent(0) returns '+0.00%'", () => {
    expect(formatPercent(0)).toBe("+0.00%");
  });

  it("formatPercent with positive value includes '+' prefix", () => {
    const result = formatPercent(0.05);
    expect(result.startsWith("+")).toBe(true);
  });

  it("formatPercent with negative value does not include '+' prefix", () => {
    const result = formatPercent(-0.05);
    expect(result.startsWith("-")).toBe(true);
  });

  it("formatPercent(NaN) does not throw", () => {
    expect(() => formatPercent(NaN)).not.toThrow();
  });

  it("formatPercent returns string always", () => {
    for (const v of [0, 0.1, -0.1, 1.0, -1.0, NaN, Infinity]) {
      expect(typeof formatPercent(v)).toBe("string");
    }
  });
});
