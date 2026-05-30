import { describe, expect, it } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import type { TaxTransaction } from "../../src/api";
import { taxTransactionQueryKeys } from "../../src/hooks/useTaxTransactions";
import {
  SyncStatus,
  TaxEmptyState,
  TaxErrorState,
  TaxLoadingState,
  TaxTransactionLedger,
  TaxTransactions,
  taxCommentDraftState,
  taxTransactionLabelOptions,
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
    expect(html).toContain("1 WHYPE");
    expect(html).toContain("transfer(address,uint256)");
    expect(html).toContain("Trade");
    expect(html).toContain("Transfer");
    expect(html).toContain("LP rebalance");
    expect(html).toContain("Save comment");
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
    expect(html.match(/>n\/a<\/span>/g)?.length).toBe(4);
    expect(html.match(/0 native/g)?.length).toBe(2);
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

    expect(html.match(/0\.252451 native/g)?.length).toBe(2);
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
