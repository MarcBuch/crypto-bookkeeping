import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const cliDir = dirname(dirname(fileURLToPath(import.meta.url)));
const tempDirs: string[] = [];

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-tracker-cli-tax-"));
  tempDirs.push(dir);
  return dir;
}

async function runCli(args: string[], dataDir = makeDataDir()): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    cwd: cliDir,
    env: {
      ...process.env,
      LP_TRACKER_DATA_DIR: dataDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

async function seedTaxTransaction(
  dataDir: string,
  overrides: { id?: string; label?: "Trade" | "Transfer" | null; comment?: string | null } = {},
): Promise<void> {
  const id = overrides.id ?? "tx-1:external";
  const proc = Bun.spawn(
    [
      "bun",
      "--eval",
      `
        import { upsertSyncedTaxTransaction, updateTaxTransaction } from "@lp-tracker/core";

        const id = ${JSON.stringify(id)};
        upsertSyncedTaxTransaction({
          id,
          hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
          block_number: 100,
          time_stamp: "2026-05-30T12:00:00.000Z",
          from_address: "0xfrom",
          to_address: "0xto",
          value: "1000000000000000000",
          gas_used: "21000",
          gas_price: "1000000000",
          fee: "21000000000000",
          method_id: "0x12345678",
          function_name: "transfer(address,uint256)",
          input: "0xabcdef",
          contract_address: null,
          token_symbol: null,
          token_decimal: null,
          token_name: null,
          transaction_type: "txlist",
          source: "test",
          is_error: 0,
          synced_at: "2026-05-30T12:01:00.000Z",
        });
        updateTaxTransaction(id, {
          label: ${JSON.stringify(overrides.label ?? null)},
          comment: ${JSON.stringify(overrides.comment ?? null)},
        });
      `,
    ],
    {
      cwd: cliDir,
      env: {
        ...process.env,
        LP_TRACKER_DATA_DIR: dataDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
}

function parseJsonStdout(result: CliResult): unknown {
  expect(result.stdout).not.toBe("");
  return JSON.parse(result.stdout);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("tax CLI argument handling", () => {
  it("rejects malformed list limits with controlled JSON", async () => {
    const result = await runCli(["--json", "tax", "list", "--limit", "abc"]);

    expect(result.exitCode).not.toBe(0);
    expect(parseJsonStdout(result)).toEqual({ error: "limit must be a non-negative integer" });
  });

  it("rejects zero list limits with controlled JSON", async () => {
    const result = await runCli(["--json", "tax", "list", "--limit", "0"]);

    expect(result.exitCode).not.toBe(0);
    expect(parseJsonStdout(result)).toEqual({ error: "limit must be a positive integer" });
  });

  it("rejects negative list offsets with controlled JSON", async () => {
    const result = await runCli(["--json", "tax", "list", "--offset", "-1"]);

    expect(result.exitCode).not.toBe(0);
    expect(parseJsonStdout(result)).toEqual({ error: "offset must be a non-negative integer" });
  });

  it("rejects invalid list labels with controlled JSON", async () => {
    const result = await runCli(["--json", "tax", "list", "--label", "Income"]);

    expect(result.exitCode).not.toBe(0);
    expect(parseJsonStdout(result)).toEqual({
      error: "label must be Trade, Transfer, or unlabeled",
    });
  });

  it("accepts unlabeled list labels", async () => {
    const result = await runCli(["--json", "tax", "list", "--label", "unlabeled"]);

    expect(result.exitCode).toBe(0);
    expect(parseJsonStdout(result)).toEqual({ transactions: [] });
  });

  it("rejects invalid update labels with controlled JSON", async () => {
    const result = await runCli(["--json", "tax", "label", "tx-1:external", "--label", "Income"]);

    expect(result.exitCode).not.toBe(0);
    expect(parseJsonStdout(result)).toEqual({
      error: "label must be Trade, Transfer, null, clear, none, or unlabeled",
    });
  });

  it("rejects label updates without a label or comment with controlled JSON", async () => {
    const result = await runCli(["--json", "tax", "label", "tx-1:external"]);

    expect(result.exitCode).not.toBe(0);
    expect(parseJsonStdout(result)).toEqual({
      error: "tax label requires --label and/or --comment",
    });
  });

  it("lets Commander reject missing get ids", async () => {
    const result = await runCli(["tax", "get"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("missing required argument 'id'");
  });

  it("lets Commander reject missing label ids", async () => {
    const result = await runCli(["tax", "label"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("missing required argument 'id'");
  });
});

describe("tax CLI JSON output contracts", () => {
  it("returns an exact empty list shape for tax list --json", async () => {
    const result = await runCli(["tax", "list", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(parseJsonStdout(result)).toEqual({ transactions: [] });
  });

  it("returns a controlled JSON not-found shape for tax get missing --json", async () => {
    const result = await runCli(["tax", "get", "missing", "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(parseJsonStdout(result)).toEqual({ error: "Tax transaction not found", id: "missing" });
  });

  it("returns a controlled JSON not-found shape for tax label missing --json", async () => {
    const result = await runCli(["tax", "label", "missing", "--label", "Trade", "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(parseJsonStdout(result)).toEqual({ error: "Tax transaction not found", id: "missing" });
  });

  it("returns a transaction envelope with stable core fields for tax get id --json", async () => {
    const dataDir = makeDataDir();
    await seedTaxTransaction(dataDir, { label: "Transfer" });

    const result = await runCli(["tax", "get", "tx-1:external", "--json"], dataDir);

    expect(result.exitCode).toBe(0);
    expect(parseJsonStdout(result)).toMatchObject({
      transaction: {
        id: "tx-1:external",
        hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
        label: "Transfer",
      },
    });
  });

  it("returns an updated transaction envelope for tax label id --json", async () => {
    const dataDir = makeDataDir();
    await seedTaxTransaction(dataDir);

    const result = await runCli(
      ["tax", "label", "tx-1:external", "--label", "Trade", "--comment", "agent note", "--json"],
      dataDir,
    );

    expect(result.exitCode).toBe(0);
    expect(parseJsonStdout(result)).toMatchObject({
      transaction: {
        id: "tx-1:external",
        label: "Trade",
        comment: "agent note",
      },
    });
  });

  it("returns a transactions array envelope for seeded tax list --json", async () => {
    const dataDir = makeDataDir();
    await seedTaxTransaction(dataDir, { label: "Trade" });

    const result = await runCli(["tax", "list", "--json"], dataDir);

    expect(result.exitCode).toBe(0);
    expect(parseJsonStdout(result)).toMatchObject({
      transactions: [
        {
          id: "tx-1:external",
          hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
          label: "Trade",
        },
      ],
    });
  });

  it("returns only unlabeled transactions for tax list --label unlabeled --json", async () => {
    const dataDir = makeDataDir();
    await seedTaxTransaction(dataDir, { id: "trade", label: "Trade" });
    await seedTaxTransaction(dataDir, { id: "transfer", label: "Transfer" });
    await seedTaxTransaction(dataDir, { id: "unlabeled", label: null });

    const result = await runCli(["tax", "list", "--label", "unlabeled", "--json"], dataDir);

    expect(result.exitCode).toBe(0);
    expect(parseJsonStdout(result)).toMatchObject({
      transactions: [{ id: "unlabeled", label: null }],
    });
  });
});
