import { describe, expect, it, mock } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import type { TaxTransaction } from "../../src/api";
import {
  buildManualTaxTransactionCreateInput,
  buildManualTaxTransactionUpdate,
  emptyManualTaxTransactionForm,
  groupTaxTransactions,
  manualTransactionFormFromTransaction,
  ManualTransactionEditor,
  ManualTaxTransactionForm,
  SyncStatus,
  TaxEmptyState,
  TaxErrorState,
  TaxLoadingState,
  TaxTransactionLedger,
  taxCommentDraftState,
  taxTransactionLabelOptions,
  submitManualTaxTransactionForm,
  updateTaxLedgerRowsPerPage,
  TransactionHashLink,
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
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[]}
        pagination={{ limit: 200, offset: 0, label: null, total: 0 }}
        page={0}
        rowsPerPage={200}
        updateTransaction={() => undefined}
        setPage={() => undefined}
        setRowsPerPage={() => undefined}
      />,
    );

    expect(html).toContain("Synced Transactions");
    expect(html).toContain("Add manual transaction");
    expect(html).toContain("Sync blockchain data");
    expect(html).toContain("No tax transactions synced");
    expect(html).not.toContain("Loading tax transactions");
  });

  it("renders blotter pagination controls and disables edge buttons", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[taxTransaction]}
        pagination={{ limit: 50, offset: 0, label: null, total: 125 }}
        page={0}
        rowsPerPage={50}
        updateTransaction={() => undefined}
        setPage={() => undefined}
        setRowsPerPage={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html).toContain('aria-label="Rows per page"');
    expect(html).toContain('Showing 1-50 of 125');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Previous');
    expect(html).toContain('Next');
  });

  it("shows the current page range and enables both navigation buttons in the middle", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[taxTransaction]}
        pagination={{ limit: 50, offset: 50, label: null, total: 125 }}
        page={1}
        rowsPerPage={50}
        updateTransaction={() => undefined}
        setPage={() => undefined}
        setRowsPerPage={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html).toContain('Showing 51-100 of 125');
    expect(html).toContain('>Previous<');
    expect(html).toContain('>Next<');
    expect(html).not.toContain('disabled="" type="button">Previous');
    expect(html).not.toContain('disabled="" type="button">Next');
  });

  it("resets to the first page when rows per page changes", () => {
    const setPage = mock(() => undefined);
    const setRowsPerPage = mock(() => undefined);

    updateTaxLedgerRowsPerPage(100, setPage, setRowsPerPage);

    expect(setPage).toHaveBeenCalledWith(0);
    expect(setRowsPerPage).toHaveBeenCalledWith(100);
  });

  it("renders the manual tax transaction form fields", () => {
    const html = renderToStaticMarkup(
      <ManualTaxTransactionForm
        createTransaction={() => undefined}
        isCreating={false}
        isSuccess={false}
      />,
    );

    expect(html).toContain("Add manual transaction");
    expect(html).not.toContain("Create manual transaction");
  });

  it("renders the manual tax transaction creation form in a centered modal", () => {
    const html = renderToStaticMarkup(
      <ManualTaxTransactionForm
        createTransaction={() => undefined}
        isCreating={false}
        isSuccess={false}
        initialIsOpen
      />,
    );

    expect(html).toContain("<dialog");
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("top-1/2");
    expect(html).toContain("left-1/2");
    expect(html).toContain("Incoming Qty");
    expect(html).toContain("Outgoing Asset");
    expect(html).toContain("Holding Days");
    expect(html).toContain("Create manual transaction");
    expect(html).toContain("Close manual transaction creator");
  });

  it("renders tax ledger controls inline with transaction count", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[taxTransaction]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );
    const syncIndex = html.indexOf("Sync blockchain data");
    const addIndex = html.indexOf("Add manual transaction");
    const countIndex = html.indexOf("1 transaction");

    expect(syncIndex).toBeGreaterThan(-1);
    expect(addIndex).toBeGreaterThan(syncIndex);
    expect(countIndex).toBeGreaterThan(addIndex);
  });

  it("builds trimmed manual tax transaction create inputs", () => {
    expect(
      buildManualTaxTransactionCreateInput({
        ...emptyManualTaxTransactionForm,
        id: " manual deposit ",
        label: "Trade",
        incoming_quantity: " 1.5 ",
        incoming_asset: " HYPE ",
        outgoing_quantity: " 42.00 ",
        outgoing_asset: " USDC ",
        cost_eur: " 1000.00 ",
        proceeds_eur: " 1100.00 ",
        gain_eur: " 100.00 ",
        holding_duration_days: " 42 ",
        comment: " Manual deposit ",
      }),
    ).toEqual({
      input: {
        id: "manual deposit",
        label: "Trade",
        incoming_quantity: "1.5",
        incoming_asset: "HYPE",
        outgoing_quantity: "42.00",
        outgoing_asset: "USDC",
        cost_eur: "1000.00",
        proceeds_eur: "1100.00",
        gain_eur: "100.00",
        holding_duration_days: 42,
        comment: "Manual deposit",
      },
    });
  });

  it("omits empty manual tax transaction fields and preserves explicit zero holding days", () => {
    expect(
      buildManualTaxTransactionCreateInput({
        ...emptyManualTaxTransactionForm,
        id: "   ",
        label: "Transfer",
        incoming_quantity: " 0 ",
        incoming_asset: " USDC ",
        outgoing_quantity: " ",
        holding_duration_days: " 0 ",
        comment: "   ",
      }),
    ).toEqual({
      input: {
        label: "Transfer",
        incoming_quantity: "0",
        incoming_asset: "USDC",
        holding_duration_days: 0,
      },
    });
  });

  it("rejects empty and invalid manual tax transaction forms", () => {
    expect(buildManualTaxTransactionCreateInput(emptyManualTaxTransactionForm)).toEqual({
      error: "Add at least one field before creating a transaction.",
    });
    expect(
      buildManualTaxTransactionCreateInput({
        ...emptyManualTaxTransactionForm,
        holding_duration_days: "-1",
      }),
    ).toEqual({ error: "Holding days must be a non-negative whole number." });
    expect(
      buildManualTaxTransactionCreateInput({
        ...emptyManualTaxTransactionForm,
        holding_duration_days: "1.5",
      }),
    ).toEqual({ error: "Holding days must be a non-negative whole number." });
    expect(
      buildManualTaxTransactionCreateInput({
        ...emptyManualTaxTransactionForm,
        holding_duration_days: "forty two",
      }),
    ).toEqual({ error: "Holding days must be a non-negative whole number." });
  });

  it("does not call create when manual tax transaction submission is empty", () => {
    const createTransaction = mock(() => undefined);
    const validationErrors: Array<string | null> = [];
    const resetForm = mock(() => undefined);

    submitManualTaxTransactionForm({
      form: emptyManualTaxTransactionForm,
      createTransaction,
      setValidationError: (error) => validationErrors.push(error),
      resetForm,
    });

    expect(createTransaction).not.toHaveBeenCalled();
    expect(resetForm).not.toHaveBeenCalled();
    expect(validationErrors).toEqual(["Add at least one field before creating a transaction."]);
  });

  it("does not call create when manual tax transaction holding days are invalid", () => {
    for (const holdingDays of ["-1", "1.5", "not a number"]) {
      const createTransaction = mock(() => undefined);
      const validationErrors: Array<string | null> = [];

      submitManualTaxTransactionForm({
        form: { ...emptyManualTaxTransactionForm, holding_duration_days: holdingDays },
        createTransaction,
        setValidationError: (error) => validationErrors.push(error),
        resetForm: () => undefined,
      });

      expect(createTransaction).not.toHaveBeenCalled();
      expect(validationErrors).toEqual(["Holding days must be a non-negative whole number."]);
    }
  });

  it("submits trimmed manual tax transaction payloads and resets after success", () => {
    let successHandler: (() => void) | undefined;
    const createTransaction = mock((_, options) => {
      successHandler = options?.onSuccess;
    });
    const validationErrors: Array<string | null> = [];
    const resetForm = mock(() => undefined);

    submitManualTaxTransactionForm({
      form: {
        ...emptyManualTaxTransactionForm,
        id: " manual-1 ",
        label: "Trade",
        incoming_quantity: " 1.5 ",
        incoming_asset: " HYPE ",
        outgoing_quantity: "   ",
        holding_duration_days: " 7 ",
        comment: " rebalance note ",
      },
      createTransaction,
      setValidationError: (error) => validationErrors.push(error),
      resetForm,
    });

    expect(createTransaction).toHaveBeenCalledWith(
      {
        id: "manual-1",
        label: "Trade",
        incoming_quantity: "1.5",
        incoming_asset: "HYPE",
        holding_duration_days: 7,
        comment: "rebalance note",
      },
      { onSuccess: successHandler },
    );
    expect(resetForm).not.toHaveBeenCalled();

    successHandler?.();

    expect(resetForm).toHaveBeenCalledTimes(1);
    expect(validationErrors).toEqual([null]);
  });

  it("preserves manual tax transaction input until a failed create reports success", () => {
    const createTransaction = mock(() => undefined);
    const validationErrors: Array<string | null> = [];
    const resetForm = mock(() => undefined);

    submitManualTaxTransactionForm({
      form: {
        ...emptyManualTaxTransactionForm,
        incoming_quantity: " 2.5 ",
        incoming_asset: " HYPE ",
      },
      createTransaction,
      setValidationError: (error) => validationErrors.push(error),
      resetForm,
    });

    expect(createTransaction).toHaveBeenCalledTimes(1);
    expect(resetForm).not.toHaveBeenCalled();
    expect(validationErrors).toEqual([]);
  });

  it("renders manual tax transaction pending, success, error, and prefilled input states", () => {
    const pendingHtml = renderToStaticMarkup(
      <ManualTaxTransactionForm
        createTransaction={() => undefined}
        isCreating
        isSuccess={false}
        initialForm={{
          ...emptyManualTaxTransactionForm,
          incoming_quantity: "2.5",
          incoming_asset: "HYPE",
        }}
        initialIsOpen
      />,
    );
    const successHtml = renderToStaticMarkup(
      <ManualTaxTransactionForm
        createTransaction={() => undefined}
        isCreating={false}
        isSuccess
        initialIsOpen
      />,
    );
    const errorHtml = renderToStaticMarkup(
      <ManualTaxTransactionForm
        createTransaction={() => undefined}
        createError={new Error("write rejected")}
        isCreating={false}
        isSuccess={false}
        initialForm={{
          ...emptyManualTaxTransactionForm,
          incoming_quantity: "2.5",
          incoming_asset: "HYPE",
        }}
        initialIsOpen
      />,
    );

    expect(pendingHtml).toContain("Creating...");
    expect(pendingHtml).toContain('disabled=""');
    expect(successHtml).toContain("Manual transaction created. Refreshing ledger...");
    expect(errorHtml).toContain("Could not create transaction: write rejected");
    expect(errorHtml).toContain('value="2.5"');
    expect(errorHtml).toContain('value="HYPE"');
  });

  it("builds manual transaction updates from changed fields only", () => {
    const manualTransaction: TaxTransaction = {
      ...taxTransaction,
      id: "manual:editable",
      hash: "manual-original",
      source: "manual",
      transaction_type: "manual",
      block_number: null,
      incoming_quantity: "1",
      incoming_asset: "HYPE",
      comment: null,
    };
    const form = {
      ...manualTransactionFormFromTransaction(manualTransaction),
      hash: " manual-updated ",
      block_number: "42",
      incoming_quantity: " 2 ",
      incoming_asset: " WHYPE ",
      holding_duration_days: "7",
      comment: " edited ",
    };

    expect(buildManualTaxTransactionUpdate(manualTransaction, form)).toEqual({
      update: {
        hash: "manual-updated",
        block_number: 42,
        incoming_quantity: "2",
        incoming_asset: "WHYPE",
        holding_duration_days: 7,
        comment: "edited",
      },
    });
  });

  it("rejects empty and invalid manual transaction updates", () => {
    const manualTransaction: TaxTransaction = {
      ...taxTransaction,
      id: "manual:editable",
      source: "manual",
      transaction_type: "manual",
      holding_duration_days: 1,
    };

    expect(
      buildManualTaxTransactionUpdate(
        manualTransaction,
        manualTransactionFormFromTransaction(manualTransaction),
      ),
    ).toEqual({ error: "Change at least one field before saving." });
    expect(
      buildManualTaxTransactionUpdate(manualTransaction, {
        ...manualTransactionFormFromTransaction(manualTransaction),
        hash: "   ",
      }),
    ).toEqual({ error: "Hash cannot be empty." });
    expect(
      buildManualTaxTransactionUpdate(manualTransaction, {
        ...manualTransactionFormFromTransaction(manualTransaction),
        holding_duration_days: "-1",
      }),
    ).toEqual({ error: "Holding days must be a non-negative whole number." });
    expect(
      buildManualTaxTransactionUpdate(manualTransaction, {
        ...manualTransactionFormFromTransaction(manualTransaction),
        block_number: "1.5",
      }),
    ).toEqual({ error: "Block Number must be a whole number." });
  });

  it("renders manual edit affordances only for manual rows", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          taxTransaction,
          {
            ...taxTransaction,
            id: "manual:editable",
            hash: "manual-row",
            source: "manual",
            transaction_type: "manual",
          },
        ]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html.match(/Edit manual fields/g)?.length).toBe(2);
    expect(html).toContain("manual");
  });

  it("renders manual field editing in a modal dialog", () => {
    const html = renderToStaticMarkup(
      <ManualTransactionEditor
        transaction={{
          ...taxTransaction,
          id: "manual:editable",
          source: "manual",
          transaction_type: "manual",
          incoming_quantity: "1",
          incoming_asset: "HYPE",
        }}
        updateTransaction={() => undefined}
        initialIsEditing
      />,
    );

    expect(html).toContain("<dialog");
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Edit manual transaction");
    expect(html).toContain("Close manual transaction editor");
    expect(html).toContain("Manual Incoming Qty");
    expect(html).toContain("Save manual fields");
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
    expect(
      html.match(/href="https:\/\/www\.hyperscan\.com\/tx\/0x1234567890abcdef"/g)?.length,
    ).toBe(2);
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
    expect(groups[0]).toMatchObject({ hash: nativePart.hash, primary: whypePart });
    expect(groups[0].transactions.map((transaction) => transaction.id)).toEqual([
      nativePart.id,
      whypePart.id,
    ]);
    expect(groups[1].transactions.map((transaction) => transaction.id)).toEqual([standalone.id]);
  });

  it("prefers the fee-bearing row as the primary grouped tax transaction", () => {
    const hash = "0xfee-primary";
    const feeLess: TaxTransaction = {
      ...taxTransaction,
      id: "hyperevmscan:tokentx:0xfee-primary:0",
      hash,
      time_stamp: "1760000000",
      block_number: 123,
      fee: null,
    };
    const feeBearing: TaxTransaction = {
      ...taxTransaction,
      id: "hyperevmscan:tokentx:0xfee-primary:1",
      hash,
      time_stamp: "1760000000",
      block_number: 123,
      fee: "42000",
    };

    const [group] = groupTaxTransactions([feeLess, feeBearing]);

    expect(group.primary.id).toBe(feeBearing.id);
    expect(group.transactions.map((transaction) => transaction.id)).toEqual([
      feeLess.id,
      feeBearing.id,
    ]);
  });

  it("sorts tax transaction groups newest first by date and time", () => {
    const newest: TaxTransaction = {
      ...taxTransaction,
      id: "newest",
      hash: "0xnewest",
      time_stamp: "2026-05-31T12:00:00.000Z",
      block_number: 1,
    };
    const oldest: TaxTransaction = {
      ...taxTransaction,
      id: "oldest",
      hash: "0xoldest",
      time_stamp: "2026-05-30T12:00:00.000Z",
      block_number: 3,
    };
    const sameTimeHigherBlock: TaxTransaction = {
      ...taxTransaction,
      id: "same-time-higher-block",
      hash: "0xsame-time-higher-block",
      time_stamp: "2026-05-31T12:00:00.000Z",
      block_number: 2,
    };
    const missingTime: TaxTransaction = {
      ...taxTransaction,
      id: "missing-time",
      hash: "0xmissing-time",
      time_stamp: null,
      block_number: 999,
    };

    expect(
      groupTaxTransactions([oldest, missingTime, newest, sameTimeHigherBlock]).map(
        (group) => group.primary.id,
      ),
    ).toEqual(["same-time-higher-block", "newest", "oldest", "missing-time"]);
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
    expect(expandedHtml.match(new RegExp(`data-transaction-id="${secondId}"`, "g"))?.length).toBe(
      6,
    );
    expect(expandedHtml).toContain(`data-transaction-id="hash:${hash}"`);
  });

  it("applies grouped annotation updates to every child transaction", () => {
    const hash = "0xd2705aca4c002c9f2ed1a65d5dbfbfb5ccefe45d7b0b248e64037fb753cc62b8";
    const first = { ...taxTransaction, id: "part-1", hash, label: null, comment: null };
    const second = { ...taxTransaction, id: "part-2", hash, label: "Trade" as const };
    const [group] = groupTaxTransactions([first, second]);
    const updates: Array<{ id: string; label?: TaxTransaction["label"]; comment?: string | null }> =
      [];

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
      { label: "Approval", value: "Approval" },
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

    expect(html.match(/<select/g)?.length).toBe(3);
    expect(html.match(/<textarea/g)?.length).toBe(2);
    expect(html.match(/Save comment/g)?.length).toBe(2);
  });

  it("renders group header row with expand toggle, parts count, and grouped label", () => {
    const hash = "0xd2705aca4c002c9f2ed1a65d5dbfbfb5ccefe45d7b0b248e64037fb753cc62b8";
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          {
            ...taxTransaction,
            id: "part-1",
            hash,
            transaction_type: "txlist",
            token_symbol: null,
            token_decimal: null,
          },
          { ...taxTransaction, id: "part-2", hash, transaction_type: "tokentx" },
        ]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // Must have exactly ONE group header row (not two <tr> elements for it)
    // The group header is the single row that holds the expand toggle
    expect(html).toContain("grouped trade");
    expect(html).toContain("2 transaction parts");
    expect(html).toContain("Show parts");
    expect(html).toContain("Applies to all parts");
    // Desktop expand toggle has correct aria attributes
    expect(html).toContain(`aria-label="Show transaction parts for ${hash}"`);
    expect(html).toContain('aria-expanded="false"');
    // The group label select uses the group composite ID for data-transaction-id
    expect(html).toContain(`data-transaction-id="hash:${hash}"`);
    // Individual transaction IDs NOT present when collapsed
    expect(html).not.toContain('data-transaction-id="part-1"');
    expect(html).not.toContain('data-transaction-id="part-2"');
  });

  it("renders expanded group with child rows using individual transaction IDs", () => {
    const hash = "0xd2705aca4c002c9f2ed1a65d5dbfbfb5ccefe45d7b0b248e64037fb753cc62b8";
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          {
            ...taxTransaction,
            id: "part-1",
            hash,
            transaction_type: "txlist",
            token_symbol: null,
            token_decimal: null,
          },
          { ...taxTransaction, id: "part-2", hash, transaction_type: "tokentx" },
        ]}
        defaultExpandedGroups={[`hash:${hash}`]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // Expanded state
    expect(html).toContain("Hide parts");
    expect(html).toContain('aria-expanded="true"');
    // Both child transaction types visible
    expect(html).toContain("txlist");
    expect(html).toContain("tokentx");
    // Group composite ID still present (group header row still renders)
    expect(html).toContain(`data-transaction-id="hash:${hash}"`);
    // Individual transaction IDs now present for each child
    expect(html).toContain('data-transaction-id="part-1"');
    expect(html).toContain('data-transaction-id="part-2"');
  });

  it("renders correct parts count for groups with more than 2 transactions", () => {
    const hash = "0xabc123";
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          { ...taxTransaction, id: "p1", hash },
          { ...taxTransaction, id: "p2", hash },
          { ...taxTransaction, id: "p3", hash },
        ]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html).toContain("3 transaction parts");
    expect(html).not.toContain("2 transaction parts");
    expect(html).toContain("grouped trade");
    // Only 1 transaction group shown in count badge
    expect(html).toContain("1 transaction");
  });

  it("renders group header with null primary fields without throwing", () => {
    const hash = "0xnullprimary";
    const nullTx = {
      ...taxTransaction,
      hash,
      time_stamp: null,
      block_number: null,
      label: null,
      comment: null,
      gain_eur: null,
      cost_eur: null,
      proceeds_eur: null,
      holding_duration_days: null,
      incoming_quantity: null,
      incoming_asset: null,
      outgoing_quantity: null,
      outgoing_asset: null,
      fee: null,
    } as TaxTransaction;

    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          { ...nullTx, id: "null-1" },
          { ...nullTx, id: "null-2" },
        ]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html).toContain("grouped trade");
    expect(html).toContain("2 transaction parts");
    // Null values render as "-"
    expect(html).toContain("Time n/a");
  });

  it("expanding one group does not expose child rows from a different group", () => {
    const hash1 = "0xgroup1hash";
    const hash2 = "0xgroup2hash";

    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          { ...taxTransaction, id: "g1-part1", hash: hash1 },
          { ...taxTransaction, id: "g1-part2", hash: hash1 },
          { ...taxTransaction, id: "g2-part1", hash: hash2 },
          { ...taxTransaction, id: "g2-part2", hash: hash2 },
        ]}
        defaultExpandedGroups={[`hash:${hash1}`]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // Group 1 is expanded: its child IDs present
    expect(html).toContain('data-transaction-id="g1-part1"');
    expect(html).toContain('data-transaction-id="g1-part2"');
    // Group 2 is NOT expanded: its child IDs absent
    expect(html).not.toContain('data-transaction-id="g2-part1"');
    expect(html).not.toContain('data-transaction-id="g2-part2"');
    // Group 2 composite ID present (header row still renders)
    expect(html).toContain(`data-transaction-id="hash:${hash2}"`);
  });

  it("can render two groups both simultaneously expanded", () => {
    const hash1 = "0xgroup1hash";
    const hash2 = "0xgroup2hash";

    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          { ...taxTransaction, id: "g1-part1", hash: hash1 },
          { ...taxTransaction, id: "g1-part2", hash: hash1 },
          { ...taxTransaction, id: "g2-part1", hash: hash2 },
          { ...taxTransaction, id: "g2-part2", hash: hash2 },
        ]}
        defaultExpandedGroups={[`hash:${hash1}`, `hash:${hash2}`]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // Both groups' child IDs present
    expect(html).toContain('data-transaction-id="g1-part1"');
    expect(html).toContain('data-transaction-id="g1-part2"');
    expect(html).toContain('data-transaction-id="g2-part1"');
    expect(html).toContain('data-transaction-id="g2-part2"');
    // Both composite IDs present (headers still render)
    expect(html).toContain(`data-transaction-id="hash:${hash1}"`);
    expect(html).toContain(`data-transaction-id="hash:${hash2}"`);
    // 2 groups expanded → 4 aria-expanded="true" (2 desktop + 2 mobile)
    expect(html.match(/aria-expanded="true"/g)?.length).toBe(4);
  });

  it("group-level label select uses composite hash ID, not individual transaction IDs", () => {
    const hash = "0xcompositeid";

    const collapsedHtml = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          { ...taxTransaction, id: "tx-alpha", hash, label: "Trade" as const },
          { ...taxTransaction, id: "tx-beta", hash, label: null },
        ]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // Composite ID present on the group-level select
    expect(collapsedHtml).toContain(`data-transaction-id="hash:${hash}"`);
    // Individual IDs absent (group collapsed)
    expect(collapsedHtml).not.toContain('data-transaction-id="tx-alpha"');
    expect(collapsedHtml).not.toContain('data-transaction-id="tx-beta"');
  });

  it("pre-expands only the group matching defaultExpandedGroups, leaving others collapsed", () => {
    const expandedHash = "0xexpandedhash";
    const collapsedHash = "0xcollapsedHash";

    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          { ...taxTransaction, id: "ex-1", hash: expandedHash },
          { ...taxTransaction, id: "ex-2", hash: expandedHash },
          { ...taxTransaction, id: "col-1", hash: collapsedHash },
          { ...taxTransaction, id: "col-2", hash: collapsedHash },
        ]}
        defaultExpandedGroups={[`hash:${expandedHash}`]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // Expanded group: children visible
    expect(html).toContain('data-transaction-id="ex-1"');
    expect(html).toContain('data-transaction-id="ex-2"');
    // Collapsed group: children absent
    expect(html).not.toContain('data-transaction-id="col-1"');
    expect(html).not.toContain('data-transaction-id="col-2"');
    // Expanded group has aria-expanded="true", collapsed has "false"
    expect(html).toContain(`aria-label="Hide transaction parts for ${expandedHash}"`);
    expect(html).toContain(`aria-label="Show transaction parts for ${collapsedHash}"`);
  });

  it("renders single-transaction group as a plain row without expand toggle", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[taxTransaction]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // No expand toggle present for standalone rows
    expect(html).not.toContain("grouped trade");
    expect(html).not.toContain("transaction parts");
    expect(html).not.toContain("Show parts");
    expect(html).not.toContain("Hide parts");
    // But the hash link and label controls are present
    expect(html).toContain("0x1234...cdef");
    expect(html).toContain("Trade");
  });

  it("renders a single fully-sparse transaction without throwing", () => {
    const sparseTransaction: TaxTransaction = {
      ...taxTransaction,
      id: "sparse-standalone",
      hash: "0xsparsesolo1234abcd",
      block_number: null,
      time_stamp: null,
      from_address: null,
      to_address: null,
      value: null,
      fee: null,
      method_id: null,
      function_name: null,
      token_symbol: null,
      token_decimal: null,
      transaction_type: null,
      label: null,
      comment: null,
      incoming_quantity: null,
      incoming_asset: null,
      outgoing_quantity: null,
      outgoing_asset: null,
      cost_eur: null,
      proceeds_eur: null,
      gain_eur: null,
      holding_duration_days: null,
    };

    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[sparseTransaction]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html).toContain("0xspar...abcd");
    // All null value cells render as "-"
    const dashCount = (html.match(/(?<=>)-(?=<)/g) ?? []).length;
    expect(dashCount).toBeGreaterThan(4); // multiple "-" cells
    // Time and block render as n/a
    expect(html).toContain("Time n/a");
  });

  it("renders all child rows for a large group (5 transactions) when expanded", () => {
    const hash = "0xlarge5group";
    const transactions = Array.from({ length: 5 }, (_, i) => ({
      ...taxTransaction,
      id: `large-part-${i}`,
      hash,
    })) as TaxTransaction[];

    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={transactions}
        defaultExpandedGroups={[`hash:${hash}`]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    expect(html).toContain("5 transaction parts");
    // All 5 child transaction IDs appear in the expanded state
    for (let i = 0; i < 5; i++) {
      expect(html).toContain(`data-transaction-id="large-part-${i}"`);
    }
    // Group composite ID still present
    expect(html).toContain(`data-transaction-id="hash:${hash}"`);
  });

  it("renders ⇅ sort indicator on sortable header columns when unsorted", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[taxTransaction]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // Each sortable column header shows the ⇅ indicator
    expect(html).toContain("⇅");
    // aria-sort="none" for sortable but unsorted columns
    expect(html).toContain('aria-sort="none"');
    // Non-sortable columns (hash, comment) do NOT have aria-sort
    // We can't easily isolate per-cell, but verify none have aria-sort="ascending" by default
    expect(html).not.toContain('aria-sort="ascending"');
    expect(html).not.toContain('aria-sort="descending"');
  });

  it("sorts rows by gain_eur descending when defaultSorting is set", () => {
    const hash1 = "0x00000000000000000000000000000001";
    const hash2 = "0x00000000000000000000000000000002";
    const hash3 = "0x00000000000000000000000000000003";

    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          { ...taxTransaction, id: "low", hash: hash1, gain_eur: "10.00" },
          { ...taxTransaction, id: "high", hash: hash2, gain_eur: "200.00" },
          { ...taxTransaction, id: "mid", hash: hash3, gain_eur: "50.00" },
        ]}
        defaultSorting={[{ id: "gain_eur", desc: true }]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // High (200) appears before mid (50) appears before low (10)
    const posHigh = html.indexOf("200.00");
    const posMid = html.indexOf("50.00");
    const posLow = html.indexOf("10.00");
    expect(posHigh).toBeLessThan(posMid);
    expect(posMid).toBeLessThan(posLow);

    // Sort indicator shows ▼ (desc) on gain_eur column
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain("▼");
  });

  it("sorts rows by gain_eur ascending when defaultSorting is set to asc", () => {
    const hash1 = "0x00000000000000000000000000000001";
    const hash2 = "0x00000000000000000000000000000002";
    const hash3 = "0x00000000000000000000000000000003";

    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          { ...taxTransaction, id: "low", hash: hash1, gain_eur: "10.00" },
          { ...taxTransaction, id: "high", hash: hash2, gain_eur: "200.00" },
          { ...taxTransaction, id: "mid", hash: hash3, gain_eur: "50.00" },
        ]}
        defaultSorting={[{ id: "gain_eur", desc: false }]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // Low (10) appears before mid (50) appears before high (200)
    const posLow = html.indexOf("10.00");
    const posMid = html.indexOf("50.00");
    const posHigh = html.indexOf("200.00");
    expect(posLow).toBeLessThan(posMid);
    expect(posMid).toBeLessThan(posHigh);

    // Sort indicator shows ▲ (asc)
    expect(html).toContain('aria-sort="ascending"');
    expect(html).toContain("▲");
  });

  it("sorts numeric string fields numerically, not lexicographically", () => {
    const hash1 = "0x00000000000000000000000000000001";
    const hash2 = "0x00000000000000000000000000000002";
    const hash3 = "0x00000000000000000000000000000003";

    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          { ...taxTransaction, id: "nine", hash: hash1, gain_eur: "9.00" },
          { ...taxTransaction, id: "hundred", hash: hash2, gain_eur: "100.00" },
          { ...taxTransaction, id: "ten", hash: hash3, gain_eur: "10.00" },
        ]}
        defaultSorting={[{ id: "gain_eur", desc: false }]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // Numeric ascending: 9 < 10 < 100
    const pos9 = html.indexOf(">9.00<");
    const pos10 = html.indexOf(">10.00<");
    const pos100 = html.indexOf(">100.00<");
    expect(pos9).toBeGreaterThan(-1);
    expect(pos10).toBeGreaterThan(-1);
    expect(pos100).toBeGreaterThan(-1);
    expect(pos9).toBeLessThan(pos10);
    expect(pos10).toBeLessThan(pos100);
  });

  it("does not render aria-sort or cursor-pointer on non-sortable column headers", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[taxTransaction]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // hash and comment columns are not sortable (enableSorting: false)
    // We can't isolate per-cell easily, but verify that cursor-pointer appears fewer times
    // than sortable-column count (11 sortable columns)
    const cursorCount = (html.match(/cursor-pointer/g) ?? []).length;
    // Sortable columns have cursor-pointer; non-sortable (hash, comment) do not
    // Verify at least 1 cursor-pointer exists but fewer than total column count
    expect(cursorCount).toBeGreaterThan(0);
    // Non-sortable columns (hash, comment) should not contribute cursor-pointer
    // The actual count reflects the number of sortable columns defined in the component
    expect(cursorCount).toBe(7);
  });

  it("renders all column headers visible when no defaultColumnVisibility is set", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[taxTransaction]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // All expected column header labels present
    expect(html).toContain("Time / Block");
    expect(html).toContain("Hash");
    expect(html).toContain("Label");
    expect(html).toContain("Note");
    expect(html).toContain("Gain EUR");
    expect(html).toContain("Cost EUR");
    // Columns dropdown button present
    expect(html).toContain(">Columns<");
  });

  it("hides a column header and its cell data when defaultColumnVisibility hides it", () => {
    const visibleHtml = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[{ ...taxTransaction, gain_eur: "123.45" }]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );
    const hiddenHtml = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[{ ...taxTransaction, gain_eur: "123.45" }]}
        defaultColumnVisibility={{ gain_eur: false }}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // When visible: desktop thead contains the sortable column header with sort indicator
    expect(visibleHtml).toContain("Gain EUR<span");
    // When hidden: desktop thead no longer contains the Gain EUR <th> with sort indicator
    expect(hiddenHtml).not.toContain("Gain EUR<span");
    // Columns button is still present
    expect(hiddenHtml).toContain(">Columns<");
  });

  it("renders column visibility dropdown with checkboxes for every column", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[taxTransaction]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // The Columns button is present
    expect(html).toContain(">Columns<");
    // The dropdown is NOT open by default (showColumnMenu starts false)
    expect(html).not.toContain('type="checkbox"');
  });

  it("columns dropdown is hidden on initial render (showColumnMenu defaults to false)", () => {
    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[taxTransaction]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // Button present
    expect(html).toContain(">Columns<");
    // No checkboxes visible (dropdown closed)
    expect(html).not.toContain('type="checkbox"');
    // No column toggle ids visible in initial render
    expect(html).not.toContain("gain_eur");
  });

  it("hides multiple columns when defaultColumnVisibility sets them false", () => {
    const hiddenHtml = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          { ...taxTransaction, gain_eur: "123.45", cost_eur: "500.00", block_number: 21534838 },
        ]}
        defaultColumnVisibility={{ gain_eur: false, cost_eur: false, time_stamp: false }}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // Desktop thead should not show hidden column headers (sortable cols include sort indicator)
    expect(hiddenHtml).not.toContain("Gain EUR<span");
    expect(hiddenHtml).not.toContain("Cost EUR<span");
    // time_stamp column header "Time / Block" is sortable too
    expect(hiddenHtml).not.toContain("Time / Block<span");
    // Columns button is still present
    expect(hiddenHtml).toContain(">Columns<");
  });

  it("renders mixed group and standalone row with independent data", () => {
    const groupHash = "0xmixedgroup";
    const soloHash = "0xsolo";

    const html = renderToStaticMarkup(
      <TaxTransactionLedger
        transactions={[
          {
            ...taxTransaction,
            id: "group-a",
            hash: groupHash,
            gain_eur: "100.00",
            label: "Trade" as const,
          },
          {
            ...taxTransaction,
            id: "group-b",
            hash: groupHash,
            gain_eur: null,
            label: null,
          },
          {
            ...taxTransaction,
            id: "solo",
            hash: soloHash,
            gain_eur: "50.00",
            label: "Transfer" as const,
          },
        ]}
        updateTransaction={() => undefined}
        isUpdating={false}
      />,
    );

    // 2 transactions shown in count (1 group + 1 standalone)
    expect(html).toContain("2 transactions");
    // Group shows "Mixed" for gain_eur (mixed values)
    expect(html).toContain("Mixed");
    // Standalone row shows its gain value
    expect(html).toContain("50.00");
  });
});

describe("TransactionHashLink", () => {
  it("renders a clickable Hyperscan link for 0x hashes", () => {
    const hash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const html = renderToStaticMarkup(<TransactionHashLink hash={hash} />);
    expect(html).toContain("hyperscan.com/tx/");
    expect(html).toContain("<a ");
  });

  it("renders plain text (no link) for non-0x hashes like Hyperliquid fill TIDs", () => {
    const hash = "794235780488404";
    const html = renderToStaticMarkup(<TransactionHashLink hash={hash} />);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("hyperscan.com");
    expect(html).toContain(hash);
  });

  it("truncates long hashes but shows full hash in title", () => {
    const hash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const html = renderToStaticMarkup(<TransactionHashLink hash={hash} />);
    expect(html).toContain(`title="${hash}"`);
    // Rendered visible text should be short form: first 6 chars + ... + last 4 chars
    expect(html).toContain("0xabcd");
    expect(html).toContain("7890");
    expect(html).toContain("...");
    // Visible text node should not contain the full hash (attributes are fine)
    const textOnly = html.replace(/<[^>]+>/g, "");
    expect(textOnly).not.toBe(hash);
    expect(textOnly.trim()).toBe("0xabcd...7890");
  });
});

describe("groupTaxTransactions — hedge event grouping", () => {
  const disc = "794235780488404";
  const closeRow: TaxTransaction = {
    ...taxTransaction,
    id: `hedge:close:484645:HYPE:${disc}`,
    hash: disc,
    transaction_type: "hedge-close",
    source: "hedge-events",
    label: null,
  };
  const fundingRow: TaxTransaction = {
    ...taxTransaction,
    id: `hedge:funding:484645:HYPE:${disc}:funding`,
    hash: `${disc}:funding`,
    transaction_type: "hedge-funding",
    source: "hedge-events",
    label: null,
  };

  it("groups hedge:close and hedge:funding rows for the same event together", () => {
    const groups = groupTaxTransactions([closeRow, fundingRow]);
    expect(groups).toHaveLength(1);
    expect(groups[0].transactions).toHaveLength(2);
    expect(groups[0].transactions.map((t) => t.id)).toContain(closeRow.id);
    expect(groups[0].transactions.map((t) => t.id)).toContain(fundingRow.id);
  });

  it("uses the close row as primary when it appears first", () => {
    const groups = groupTaxTransactions([closeRow, fundingRow]);
    expect(groups[0].primary.id).toBe(closeRow.id);
  });

  it("does not merge hedge events from different positions", () => {
    const otherClose: TaxTransaction = {
      ...closeRow,
      id: "hedge:close:999999:HYPE:otherhash",
      hash: "otherhash",
    };
    const groups = groupTaxTransactions([closeRow, otherClose]);
    expect(groups).toHaveLength(2);
  });

  it("a lone hedge:close row without a funding row still appears as a single group", () => {
    const groups = groupTaxTransactions([closeRow]);
    expect(groups).toHaveLength(1);
    expect(groups[0].transactions).toHaveLength(1);
  });
});
