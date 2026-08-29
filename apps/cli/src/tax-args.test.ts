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
  overrides: {
    id?: string;
    label?: "Trade" | "Transfer" | "Approval" | "Repay Loan" | null;
    comment?: string | null;
    incoming_quantity?: string | null;
    incoming_asset?: string | null;
    outgoing_quantity?: string | null;
    outgoing_asset?: string | null;
    cost_eur?: string | null;
    proceeds_eur?: string | null;
    gain_eur?: string | null;
    holding_duration_days?: number | null;
  } = {},
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
          incoming_quantity: ${JSON.stringify(overrides.incoming_quantity ?? null)},
          incoming_asset: ${JSON.stringify(overrides.incoming_asset ?? null)},
          outgoing_quantity: ${JSON.stringify(overrides.outgoing_quantity ?? null)},
          outgoing_asset: ${JSON.stringify(overrides.outgoing_asset ?? null)},
          cost_eur: ${JSON.stringify(overrides.cost_eur ?? null)},
          proceeds_eur: ${JSON.stringify(overrides.proceeds_eur ?? null)},
          gain_eur: ${JSON.stringify(overrides.gain_eur ?? null)},
          holding_duration_days: ${JSON.stringify(overrides.holding_duration_days ?? null)},
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
      error: "label must be Trade, Transfer, Approval, Repay Loan, Derivative, or unlabeled",
    });
  });

  it("accepts unlabeled list labels", async () => {
    const result = await runCli(["--json", "tax", "list", "--label", "unlabeled"]);

    expect(result.exitCode).toBe(0);
    expect(parseJsonStdout(result)).toEqual({ transactions: [] });
  });

  it("accepts Approval list labels", async () => {
    const result = await runCli(["--json", "tax", "list", "--label", "Approval"]);

    expect(result.exitCode).toBe(0);
    expect(parseJsonStdout(result)).toEqual({ transactions: [] });
  });

  it("accepts Repay Loan list labels", async () => {
    const result = await runCli(["--json", "tax", "list", "--label", "Repay Loan"]);

    expect(result.exitCode).toBe(0);
    expect(parseJsonStdout(result)).toEqual({ transactions: [] });
  });

  it("accepts Derivative list labels", async () => {
    const result = await runCli(["--json", "tax", "list", "--label", "Derivative"]);

    expect(result.exitCode).toBe(0);
    expect(parseJsonStdout(result)).toEqual({ transactions: [] });
  });

  it("rejects invalid update labels with controlled JSON", async () => {
    const result = await runCli(["--json", "tax", "label", "tx-1:external", "--label", "Income"]);

    expect(result.exitCode).not.toBe(0);
    expect(parseJsonStdout(result)).toEqual({
      error:
        "label must be Trade, Transfer, Approval, Repay Loan, Derivative, null, clear, none, or unlabeled",
    });
  });

  it("accepts Approval update labels", async () => {
    const dataDir = makeDataDir();
    await seedTaxTransaction(dataDir);

    const result = await runCli(
      ["--json", "tax", "label", "tx-1:external", "--label", "Approval"],
      dataDir,
    );

    expect(result.exitCode).toBe(0);
    expect(parseJsonStdout(result)).toMatchObject({
      transaction: { id: "tx-1:external", label: "Approval" },
    });
  });

  it("accepts Repay Loan update labels", async () => {
    const dataDir = makeDataDir();
    await seedTaxTransaction(dataDir);

    const result = await runCli(
      ["--json", "tax", "label", "tx-1:external", "--label", "Repay Loan"],
      dataDir,
    );

    expect(result.exitCode).toBe(0);
    expect(parseJsonStdout(result)).toMatchObject({
      transaction: { id: "tx-1:external", label: "Repay Loan" },
    });
  });

  it("accepts Derivative update labels", async () => {
    const dataDir = makeDataDir();
    await seedTaxTransaction(dataDir);

    const result = await runCli(
      ["--json", "tax", "label", "tx-1:external", "--label", "Derivative"],
      dataDir,
    );

    expect(result.exitCode).toBe(0);
    expect(parseJsonStdout(result)).toMatchObject({
      transaction: { id: "tx-1:external", label: "Derivative" },
    });
  });

  it("rejects label updates without a label or comment with controlled JSON", async () => {
    const result = await runCli(["--json", "tax", "label", "tx-1:external"]);

    expect(result.exitCode).not.toBe(0);
    expect(parseJsonStdout(result)).toEqual({
      error: "tax label requires --label and/or --comment",
    });
  });

  it("rejects empty tax add requests with controlled JSON", async () => {
    const result = await runCli(["--json", "tax", "add"]);

    expect(result.exitCode).not.toBe(0);
    expect(parseJsonStdout(result)).toEqual({
      error: "tax add requires at least one manual field",
    });
  });

  it("rejects invalid tax add labels with controlled JSON", async () => {
    const result = await runCli(["--json", "tax", "add", "--label", "Income"]);

    expect(result.exitCode).not.toBe(0);
    expect(parseJsonStdout(result)).toEqual({
      error:
        "label must be Trade, Transfer, Approval, Repay Loan, Derivative, null, clear, none, or unlabeled",
    });
  });

  it("rejects malformed tax add holding days with controlled JSON", async () => {
    const result = await runCli(["--json", "tax", "add", "--holding-days", "abc"]);

    expect(result.exitCode).not.toBe(0);
    expect(parseJsonStdout(result)).toEqual({
      error: "holding-days must be a non-negative integer",
    });
  });

  it("rejects negative tax add holding days with controlled JSON", async () => {
    const result = await runCli(["--json", "tax", "add", "--holding-days=-1"]);

    expect(result.exitCode).not.toBe(0);
    expect(parseJsonStdout(result)).toEqual({
      error: "holding-days must be a non-negative integer",
    });
  });

  it("rejects invalid explicit tax add ids with controlled JSON", async () => {
    const result = await runCli(["--json", "tax", "add", "--id", " -- !! "]);

    expect(result.exitCode).not.toBe(0);
    expect(parseJsonStdout(result)).toEqual({
      error: "Manual tax transaction id must contain at least one safe character",
    });
  });

  it("rejects duplicate explicit tax add ids with controlled JSON", async () => {
    const dataDir = makeDataDir();
    const first = await runCli(["--json", "tax", "add", "--id", "duplicate-lot"], dataDir);
    expect(first.exitCode).toBe(0);

    const result = await runCli(["--json", "tax", "add", "--id", "manual:duplicate-lot"], dataDir);

    expect(result.exitCode).not.toBe(0);
    expect(parseJsonStdout(result)).toEqual({
      error: "Manual tax transaction already exists: manual:duplicate-lot",
    });
  });

});

describe("tax CLI JSON output contracts", () => {
  it("prints tax ledger fields in human-readable tax list output", async () => {
    const dataDir = makeDataDir();
    await seedTaxTransaction(dataDir, {
      label: "Transfer",
      comment: "coinbase deposit",
      incoming_quantity: "0.25245129",
      incoming_asset: "HYPE",
      cost_eur: "100.00",
      proceeds_eur: "-",
      gain_eur: "0.00",
      holding_duration_days: 0,
    });

    const result = await runCli(["tax", "list"], dataDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tx-1:external | Transfer | 2026-05-30T12:00:00.000Z");
    expect(result.stdout).toContain("in 0.25245129 HYPE");
    expect(result.stdout).toContain("out -");
    expect(result.stdout).toContain("fee 0.000021 HYPE");
    expect(result.stdout).toContain("cost EUR 100.00");
    expect(result.stdout).toContain("proceeds EUR -");
    expect(result.stdout).toContain("gain EUR 0.00");
    expect(result.stdout).toContain("holding days 0");
    expect(result.stdout).toContain("note coinbase deposit");
  });

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

  it("adds a manual tax transaction as JSON and retrieves it from the same data dir", async () => {
    const dataDir = makeDataDir();

    const add = await runCli(
      [
        "tax",
        "add",
        "--json",
        "--id",
        "cli-lot-1",
        "--hash",
        "0xmanual",
        "--time",
        "2026-05-31T10:11:12.000Z",
        "--label",
        "Trade",
        "--comment",
        "manual trade",
        "--incoming-quantity",
        "1.5",
        "--incoming-asset",
        "HYPE",
        "--outgoing-quantity",
        "42",
        "--outgoing-asset",
        "USDC",
        "--fee",
        "21000000000000",
        "--cost-eur",
        "100.00",
        "--proceeds-eur",
        "120.50",
        "--gain-eur",
        "20.50",
        "--holding-days",
        "365",
      ],
      dataDir,
    );

    expect(add.exitCode).toBe(0);
    expect(parseJsonStdout(add)).toMatchObject({
      transaction: {
        id: "manual:cli-lot-1",
        hash: "0xmanual",
        time_stamp: "2026-05-31T10:11:12.000Z",
        label: "Trade",
        comment: "manual trade",
        incoming_quantity: "1.5",
        incoming_asset: "HYPE",
        outgoing_quantity: "42",
        outgoing_asset: "USDC",
        fee: "21000000000000",
        cost_eur: "100.00",
        proceeds_eur: "120.50",
        gain_eur: "20.50",
        holding_duration_days: 365,
        source: "manual",
        transaction_type: "manual",
      },
    });

    const list = await runCli(["tax", "list", "--json"], dataDir);
    expect(list.exitCode).toBe(0);
    expect(parseJsonStdout(list)).toMatchObject({
      transactions: [{ id: "manual:cli-lot-1", label: "Trade", comment: "manual trade" }],
    });

    const get = await runCli(["tax", "get", "manual:cli-lot-1", "--json"], dataDir);
    expect(get.exitCode).toBe(0);
    expect(parseJsonStdout(get)).toMatchObject({
      transaction: { id: "manual:cli-lot-1", label: "Trade", comment: "manual trade" },
    });
  });

  it("prints tax add confirmation and formatted ledger fields in human-readable output", async () => {
    const result = await runCli([
      "tax",
      "add",
      "--id",
      "human-lot",
      "--time",
      "2026-05-31T11:00:00.000Z",
      "--label",
      "Transfer",
      "--comment",
      "manual deposit",
      "--incoming-quantity",
      "0.25",
      "--incoming-asset",
      "HYPE",
      "--fee",
      "21000000000000",
      "--cost-eur",
      "50.00",
      "--proceeds-eur",
      "-",
      "--gain-eur",
      "0.00",
      "--holding-days",
      "0",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Added tax transaction manual:human-lot.");
    expect(result.stdout).toContain("manual:human-lot | Transfer | 2026-05-31T11:00:00.000Z");
    expect(result.stdout).toContain("in 0.25 HYPE");
    expect(result.stdout).toContain("out -");
    expect(result.stdout).toContain("fee 0.000021 HYPE");
    expect(result.stdout).toContain("cost EUR 50.00");
    expect(result.stdout).toContain("proceeds EUR -");
    expect(result.stdout).toContain("gain EUR 0.00");
    expect(result.stdout).toContain("holding days 0");
    expect(result.stdout).toContain("note manual deposit");
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
