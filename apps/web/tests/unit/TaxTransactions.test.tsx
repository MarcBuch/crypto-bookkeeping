import { describe, expect, it } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import type { TaxTransaction } from "../../src/api";
import { taxTransactionQueryKeys } from "../../src/hooks/useTaxTransactions";
import {
  groupTaxTransactions,
  SyncStatus,
  TaxEmptyState,
  TaxErrorState,
  TaxLoadingState,
  TaxTransactionLedger,
  TaxTransactions,
  taxCommentDraftState,
  taxTransactionLabelOptions,
  updateTaxTransactionGroup,
} from "../../src/TaxTransactions";

const taxTransaction: TaxTransaction = {
  id: "hyperevmscan:txlist:0xhash:external",
  hash: "0x1234567890abcdef",
  block_number: 123,
  time_stamp: "1760000000",
  from_address: "0xfrom000000000000000000000000000000000000",
  to_address: "0xto00000000000000000000000000000000000000",
  value: "1000000000000000000",
  gas_used: "21000",
  gas_price: "1000000000",
  fee: "21000000000000",
  method_id: "0x12345678",
  function_name: "transfer(address,uint256)",
  input: "0x12345678",
  contract_address: null,
  token_symbol: "WHYPE",
  token_decimal: 18,
  token_name: "Wrapped HYPE",
  transaction_type: "token",
  source: "hyperevmscan",
  is_error: 0,
  label: "Trade",
  incoming_quantity: null,
  incoming_asset: null,
  outgoing_quantity: null,
  outgoing_asset: null,
  cost_eur: null,
  proceeds_eur: null,
  gain_eur: null,
  holding_duration_days: null,
  comment: "LP rebalance",
  synced_at: "2026-05-30T12:00:00.000Z",
  created_at: "2026-05-30T12:00:00.000Z",
  updated_at: "2026-05-30T12:00:00.000Z",
};

function renderTaxScreen(queryClient: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TaxTransactions />
    </QueryClientProvider>,
  );
}

describe("tax transactions rendering", () => {
  it("renders loading and empty states", () => {
    expect(renderToStaticMarkup(<TaxLoadingState />)).toContain("Loading tax transactions");
    expect(renderToStaticMarkup(<TaxEmptyState />)).toContain("No tax transactions synced");
  });

  it("renders a useful tax query error state", () => {
    const html = renderToStaticMarkup(<TaxErrorState error={new Error("tax API unavailable")} />);

    expect(html).toContain("Could not load tax transactions");
    expect(html).toContain("tax API unavailable");
  });

  it("renders a sync error status", () => {
    const html = renderToStaticMarkup(
      <SyncStatus
        mutation={{
          error: new Error("scanner timeout"),
          isError: true,
          isPending: false,
          isSuccess: false,
        }}
        isFetching={false}
      />,
    );

    expect(html).toContain("Sync failed");
    expect(html).toContain("scanner timeout");
  });

  it("renders the tax screen with cached empty transactions", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(taxTransactionQueryKeys.list({ limit: 200 }), []);

    const html = renderTaxScreen(queryClient);

    expect(html).toContain("Transaction Labeling Ledger");
    expect(html).toContain("Sync blockchain data");
    expect(html).toContain("No tax transactions synced");
    expect(html).not.toContain("Loading tax transactions");
  });

  it("renders transaction labels and comments", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[taxTransaction]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html).toContain("Synced Transactions");
    expect(html).toContain("0x1234...cdef");
    expect(html.match(/href="https:\/\/www\.hyperscan\.com\/tx\/0x1234567890abcdef"/g)?.length).toBe(2);
    expect(html).toContain("Incoming Qty");
    expect(html).toContain("Incoming Asset");
    expect(html).toContain("Outgoing Qty");
    expect(html).toContain("Outgoing Asset");
    expect(html).toContain("0.000021 HYPE");
    expect(html).not.toContain("0.000021 WHYPE");
    expect(html).toContain("Cost EUR");
    expect(html).toContain("Proceeds EUR");
    expect(html).toContain("Gain EUR");
    expect(html).toContain("Holding Days");
    expect(html).toContain("1 WHYPE");
    expect(html).toContain("transfer(address,uint256)");
    expect(html).toContain("Trade");
    expect(html).toContain("Transfer");
    expect(html).toContain("LP rebalance");
    expect(html).toContain("Save comment");
  });

  it("renders populated tax ledger fields", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          {
            ...taxTransaction,
            incoming_quantity: "25",
            incoming_asset: "WHYPE",
            outgoing_quantity: "25",
            outgoing_asset: "HYPE",
            cost_eur: "1000.00",
            proceeds_eur: "1100.00",
            gain_eur: "100.00",
            holding_duration_days: 42,
          },
        ]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html).toContain("25");
    expect(html).toContain("WHYPE");
    expect(html).toContain("HYPE");
    expect(html).toContain("1000.00");
    expect(html).toContain("1100.00");
    expect(html).toContain("100.00");
    expect(html).toContain("42");
  });

  it("groups duplicate transaction hashes while preserving child rows", () => {
    const nativePart: TaxTransaction = {
      ...taxTransaction,
      id: "hyperevmscan:txlist:0xwrap:external",
      hash: "0xd2705aca4c002c9f2ed1a65d5dbfbfb5ccefe45d7b0b248e64037fb753cc62b8",
      value: "25000000000000000000",
      token_symbol: null,
      token_decimal: null,
      transaction_type: "txlist",
      label: null,
    };
    const whypePart: TaxTransaction = {
      ...taxTransaction,
      id: "hyperevmscan:tokentx:0xwrap:1",
      hash: nativePart.hash,
      value: "25000000000000000000",
      token_symbol: "WHYPE",
      token_decimal: 18,
      transaction_type: "tokentx",
      label: null,
    };
    const standalone: TaxTransaction = {
      ...taxTransaction,
      id: "hyperevmscan:txlist:0xsolo:external",
      hash: "0xsolo",
    };

    const groups = groupTaxTransactions([nativePart, whypePart, standalone]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ hash: nativePart.hash, primary: nativePart });
    expect(groups[0].transactions.map((transaction) => transaction.id)).toEqual([
      nativePart.id,
      whypePart.id,
    ]);
    expect(groups[1].transactions.map((transaction) => transaction.id)).toEqual([standalone.id]);
  });

  it("renders duplicate hashes as one collapsed grouped trade", () => {
    const hash = "0xd2705aca4c002c9f2ed1a65d5dbfbfb5ccefe45d7b0b248e64037fb753cc62b8";
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          {
            ...taxTransaction,
            id: "hyperevmscan:txlist:0xwrap:external",
            hash,
            value: "25000000000000000000",
            token_symbol: null,
            token_decimal: null,
            transaction_type: "txlist",
            function_name: "deposit()",
            label: null,
          },
          {
            ...taxTransaction,
            id: "hyperevmscan:tokentx:0xwrap:1",
            hash,
            value: "25000000000000000000",
            token_symbol: "WHYPE",
            token_decimal: 18,
            transaction_type: "tokentx",
            label: null,
          },
        ]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html).toContain("1 transaction");
    expect(html).toContain("grouped trade");
    expect(html).toContain("2 transaction parts");
    expect(html).toContain("25 native -&gt; 25 WHYPE");
    expect(html).toContain("Show parts");
    expect(html).toContain("Show transaction parts");
    expect(html).toContain(`aria-label="Show transaction parts for ${hash}"`);
    expect(html.match(/aria-expanded="false"/g)?.length).toBe(2);
    expect(html).not.toContain("txlist</span>");
    expect(html).not.toContain("tokentx</span>");
  });

  it("summarizes WHYPE unwraps with the received native amount", () => {
    const hash = "0x27c12a5d4c8445f762fb4e9355b373ed30b48c042f2efeccf0321badd7cd71d3";
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          {
            ...taxTransaction,
            id: "hyperscan:tokentx:0xunwrap:token",
            hash,
            value: "25000000000000000000",
            token_symbol: "WHYPE",
            token_decimal: 18,
            transaction_type: "tokentx",
          },
          {
            ...taxTransaction,
            id: "hyperscan:txlist:0xunwrap:external",
            hash,
            value: "0",
            token_symbol: null,
            token_decimal: null,
            transaction_type: "txlist",
            function_name: "withdraw(uint256)",
          },
        ]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html).toContain("25 WHYPE -&gt; 25 native");
    expect(html).not.toContain("25 WHYPE -&gt; 0 native");
  });

  it("summarizes zero-value WHYPE wraps in native-to-WHYPE order", () => {
    const hash = "0xd2705aca4c002c9f2ed1a65d5dbfbfb5ccefe45d7b0b248e64037fb753cc62b8";
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          {
            ...taxTransaction,
            id: "hyperscan:txlist:0xwrap:external",
            hash,
            value: "0",
            token_symbol: null,
            token_decimal: null,
            transaction_type: "txlist",
            function_name: "deposit()",
          },
          {
            ...taxTransaction,
            id: "hyperscan:tokentx:0xwrap:token",
            hash,
            value: "25000000000000000000",
            token_symbol: "WHYPE",
            token_decimal: 18,
            transaction_type: "tokentx",
          },
        ]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html).toContain("25 native -&gt; 25 WHYPE");
    expect(html).not.toContain("25 WHYPE -&gt; 25 native");
  });

  it("can render expanded duplicate-hash groups with all child parts", () => {
    const hash = "0xd2705aca4c002c9f2ed1a65d5dbfbfb5ccefe45d7b0b248e64037fb753cc62b8";
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          {
            ...taxTransaction,
            id: "hyperevmscan:txlist:0xwrap:external",
            hash,
            value: "25000000000000000000",
            token_symbol: null,
            token_decimal: null,
            transaction_type: "txlist",
            label: null,
          },
          {
            ...taxTransaction,
            id: "hyperevmscan:tokentx:0xwrap:1",
            hash,
            value: "25000000000000000000",
            token_symbol: "WHYPE",
            token_decimal: 18,
            transaction_type: "tokentx",
            label: null,
          },
        ]}
        defaultExpandedGroups={[`hash:${hash}`]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html).toContain("Hide parts");
    expect(html).toContain("Hide transaction parts");
    expect(html).toContain(`aria-label="Hide transaction parts for ${hash}"`);
    expect(html.match(/aria-expanded="true"/g)?.length).toBe(2);
    expect(html).toContain("Applies to all parts");
    expect(html).toContain("txlist</span>");
    expect(html).toContain("tokentx</span>");
    expect(html.match(/0\.000021 HYPE/g)?.length).toBe(2);
    expect(html).not.toContain("0.000021 WHYPE");
    expect(html.match(/25 native/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/25 WHYPE/g)?.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps grouped annotation controls scoped to expanded child transaction ids", () => {
    const hash = "0xd2705aca4c002c9f2ed1a65d5dbfbfb5ccefe45d7b0b248e64037fb753cc62b8";
    const firstId = "hyperevmscan:txlist:0xwrap:external";
    const secondId = "hyperevmscan:tokentx:0xwrap:1";
    const collapsedHtml = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          { ...taxTransaction, id: firstId, hash, token_symbol: null, token_decimal: null },
          { ...taxTransaction, id: secondId, hash, token_symbol: "WHYPE", token_decimal: 18 },
        ]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );
    const expandedHtml = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          { ...taxTransaction, id: firstId, hash, token_symbol: null, token_decimal: null },
          { ...taxTransaction, id: secondId, hash, token_symbol: "WHYPE", token_decimal: 18 },
        ]}
        defaultExpandedGroups={[`hash:${hash}`]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(collapsedHtml).toContain(`data-transaction-id="hash:${hash}"`);
    expect(collapsedHtml).not.toContain(`data-transaction-id="${firstId}"`);
    expect(collapsedHtml).not.toContain(`data-transaction-id="${secondId}"`);
    expect(expandedHtml.match(new RegExp(`data-transaction-id="${firstId}"`, "g"))?.length).toBe(6);
    expect(expandedHtml.match(new RegExp(`data-transaction-id="${secondId}"`, "g"))?.length).toBe(6);
    expect(expandedHtml).toContain(`data-transaction-id="hash:${hash}"`);
  });

  it("applies grouped annotation updates to every child transaction", () => {
    const hash = "0xd2705aca4c002c9f2ed1a65d5dbfbfb5ccefe45d7b0b248e64037fb753cc62b8";
    const first = { ...taxTransaction, id: "part-1", hash, label: null, comment: null };
    const second = { ...taxTransaction, id: "part-2", hash, label: "Trade" as const };
    const [group] = groupTaxTransactions([first, second]);
    const updates: Array<{ id: string; label?: TaxTransaction["label"]; comment?: string | null }> = [];

    updateTaxTransactionGroup(group, { label: "Transfer", comment: "WHYPE wrap" }, (id, update) =>
      updates.push({ id, ...update }),
    );

    expect(updates).toEqual([
      { id: "part-1", label: "Transfer", comment: "WHYPE wrap" },
      { id: "part-2", label: "Transfer", comment: "WHYPE wrap" },
    ]);
  });

  it("groups sparse same-hash rows without throwing", () => {
    const sparseTransaction: TaxTransaction = {
      ...taxTransaction,
      id: "hyperevmscan:txlist:0xsparse:external",
      hash: "0xsparse",
      block_number: null,
      time_stamp: null,
      from_address: null,
      to_address: null,
      value: null,
      method_id: null,
      function_name: null,
      token_symbol: null,
      token_decimal: null,
      transaction_type: null,
      label: null,
      comment: null,
    };
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[sparseTransaction, { ...sparseTransaction, id: "part-2" }]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html).toContain("0xsparse");
    expect(html).toContain("Time n/a");
    expect(html).toContain("Block n/a");
    expect(html).toContain("0 native -&gt; 0 native");
  });

  it("limits label select choices to supported tax labels", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[taxTransaction]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(taxTransactionLabelOptions).toEqual([
      { label: "Unlabeled", value: "" },
      { label: "Trade", value: "Trade" },
      { label: "Transfer", value: "Transfer" },
    ]);
    for (const option of taxTransactionLabelOptions) {
      expect(html).toContain(`>${option.label}</option>`);
    }
    expect(html).not.toContain("Income");
    expect(html).not.toContain("Expense");
  });

  it("tracks comment draft persistence state", () => {
    expect(taxCommentDraftState("LP rebalance", "LP rebalance")).toEqual({
      isDirty: false,
      update: "LP rebalance",
    });
    expect(taxCommentDraftState("LP rebalance", "LP rebalance after sync")).toEqual({
      isDirty: true,
      update: "LP rebalance after sync",
    });
    expect(taxCommentDraftState("LP rebalance", "   ")).toEqual({
      isDirty: true,
      update: null,
    });
    expect(taxCommentDraftState(null, "")).toEqual({ isDirty: false, update: null });
  });

  it("renders unchanged comment editors with disabled save buttons", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[taxTransaction]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html.match(/<textarea/g)?.length).toBe(2);
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html.match(/Save comment/g)?.length).toBe(2);
  });

  it("renders rows with missing transaction metadata without throwing", () => {
    const sparseTransaction: TaxTransaction = {
      ...taxTransaction,
      id: "hyperevmscan:txlist:0xsparse:external",
      hash: "0xsparse",
      block_number: null,
      time_stamp: null,
      from_address: null,
      to_address: null,
      value: null,
      method_id: null,
      function_name: null,
      token_symbol: null,
      token_decimal: null,
      transaction_type: null,
      label: null,
      comment: null,
    };

    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[sparseTransaction]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html).toContain("0xsparse");
    expect(html.match(/Time n\/a/g)?.length).toBe(2);
    expect(html.match(/Block n\/a/g)?.length).toBe(2);
    expect(html.match(/>n\/a<\/span>/g)?.length).toBe(2);
    expect(html).toContain("0 native");
    expect(html).toContain("Unknown function");
    expect(html).toContain("Unlabeled");
  });

  it("formats native transaction values with 18 decimals", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          {
            ...taxTransaction,
            value: "252451290000000000",
            token_symbol: null,
            token_decimal: null,
          },
        ]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html.match(/0\.252451 native/g)?.length).toBe(1);
    expect(html).not.toContain("252451290000000000 native");
  });

  it("renders update errors above the transaction ledger", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[taxTransaction]}
        updateTransaction={() => undefined}
        updateError={new Error("write rejected")}
        isUpdating={false}
      />,
    );

    expect(html).toContain("Could not save transaction metadata");
    expect(html).toContain("write rejected");
  });

  it("keeps label and comment controls in both desktop and mobile layouts", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[taxTransaction]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html.match(/<select/g)?.length).toBe(2);
    expect(html.match(/<textarea/g)?.length).toBe(2);
    expect(html.match(/Save comment/g)?.length).toBe(2);
  });
});
