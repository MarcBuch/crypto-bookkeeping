import {
  type ExpandedState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";

import type {
  ManualTaxTransactionCreateInput,
  TaxTransaction,
  TaxTransactionLabel,
  TaxTransactionUpdate,
} from "./api";
import {
  useCreateTaxTransaction,
  useSyncTaxTransactions,
  useTaxTransactions,
  useUpdateTaxTransaction,
} from "./hooks/useTaxTransactions";
import { type TableMeta, taxTableColumns } from "./TaxTableColumns";

export const taxTransactionLabelOptions: Array<{
  label: string;
  value: "" | NonNullable<TaxTransactionLabel>;
}> = [
  { label: "Unlabeled", value: "" },
  { label: "Trade", value: "Trade" },
  { label: "Transfer", value: "Transfer" },
];

export function taxCommentDraftState(transactionComment: string | null, draft: string) {
  const savedComment = transactionComment ?? "";
  return {
    isDirty: draft !== savedComment,
    update: draft.trim() === "" ? null : draft,
  };
}

export interface TaxTransactionGroup {
  id: string;
  hash: string;
  primary: TaxTransaction;
  transactions: TaxTransaction[];
}

export type TaxTableRow = TaxTransaction & {
  /**
   * Set only on group header rows (groups with 2+ transactions sharing a hash).
   * Provides the full TaxTransactionGroup context for group-specific cell rendering
   * (e.g. "N parts" badge, "Applies to all parts" hint, mixed-value display).
   */
  groupData?: TaxTransactionGroup;
  /**
   * Set only on group header rows. Contains the individual child transactions
   * as TaxTableRow entries (without their own subRows or groupData).
   * Used by TanStack Table's getSubRows to produce expandable sub-rows.
   */
  subRows?: TaxTableRow[];
};

export function buildTableRows(transactions: TaxTransaction[]): TaxTableRow[] {
  const groups = groupTaxTransactions(transactions);
  return groups.map((group) => {
    if (group.transactions.length === 1) {
      return { ...group.primary };
    }
    return {
      ...group.primary,
      groupData: group,
      subRows: group.transactions.map((tx) => ({ ...tx })),
    };
  });
}

type UpdateTaxTransaction = (id: string, update: TaxTransactionUpdate) => void;

type CreateManualTaxTransaction = (
  input: ManualTaxTransactionCreateInput,
  options?: { onSuccess?: () => void },
) => void;

const idleTaxSyncMutation = {
  mutate: () => undefined,
  isError: false,
  isPending: false,
  isSuccess: false,
};

export interface ManualTaxTransactionFormState {
  hash: string;
  block_number: string;
  id: string;
  time_stamp: string;
  from_address: string;
  to_address: string;
  value: string;
  gas_used: string;
  gas_price: string;
  fee: string;
  method_id: string;
  function_name: string;
  input: string;
  contract_address: string;
  token_symbol: string;
  token_decimal: string;
  token_name: string;
  is_error: string;
  label: "" | NonNullable<TaxTransactionLabel>;
  incoming_quantity: string;
  incoming_asset: string;
  outgoing_quantity: string;
  outgoing_asset: string;
  cost_eur: string;
  proceeds_eur: string;
  gain_eur: string;
  holding_duration_days: string;
  comment: string;
}

export const emptyManualTaxTransactionForm: ManualTaxTransactionFormState = {
  hash: "",
  block_number: "",
  id: "",
  time_stamp: "",
  from_address: "",
  to_address: "",
  value: "",
  gas_used: "",
  gas_price: "",
  fee: "",
  method_id: "",
  function_name: "",
  input: "",
  contract_address: "",
  token_symbol: "",
  token_decimal: "",
  token_name: "",
  is_error: "",
  label: "",
  incoming_quantity: "",
  incoming_asset: "",
  outgoing_quantity: "",
  outgoing_asset: "",
  cost_eur: "",
  proceeds_eur: "",
  gain_eur: "",
  holding_duration_days: "",
  comment: "",
};

export function buildManualTaxTransactionCreateInput(form: ManualTaxTransactionFormState): {
  input?: ManualTaxTransactionCreateInput;
  error?: string;
} {
  const input = buildManualTaxTransactionCreateDraft(form);

  const holdingDays = form.holding_duration_days.trim();
  if (holdingDays !== "") {
    if (!/^\d+$/.test(holdingDays)) {
      return { error: "Holding days must be a non-negative whole number." };
    }
    const parsedHoldingDays = Number(holdingDays);
    if (!Number.isSafeInteger(parsedHoldingDays)) {
      return { error: "Holding days must be a non-negative whole number." };
    }
    input.holding_duration_days = parsedHoldingDays;
  }

  for (const field of editableManualTaxTransactionIntegerFields) {
    if (field === "holding_duration_days" || form[field].trim() === "") continue;
    const parsed = parseManualIntegerField(field, form[field]);
    if (parsed.error) return { error: parsed.error };
    input[field] = parsed.value as never;
  }

  if (Object.keys(input).length === 0) {
    return { error: "Add at least one field before creating a transaction." };
  }

  return { input };
}

function buildManualTaxTransactionCreateDraft(
  form: ManualTaxTransactionFormState,
): ManualTaxTransactionCreateInput {
  const input: ManualTaxTransactionCreateInput = {};

  addTrimmedField(input, "id", form.id);
  for (const field of editableManualTaxTransactionStringFields) {
    if (field === "comment") continue;
    addTrimmedField(input, field, form[field]);
  }
  if (form.label !== "") input.label = form.label;
  addTrimmedField(input, "comment", form.comment);

  return input;
}

const editableManualTaxTransactionStringFields = [
  "hash",
  "time_stamp",
  "from_address",
  "to_address",
  "value",
  "gas_used",
  "gas_price",
  "fee",
  "method_id",
  "function_name",
  "input",
  "contract_address",
  "token_symbol",
  "token_name",
  "incoming_quantity",
  "incoming_asset",
  "outgoing_quantity",
  "outgoing_asset",
  "cost_eur",
  "proceeds_eur",
  "gain_eur",
  "comment",
] as const satisfies ReadonlyArray<
  keyof TaxTransactionUpdate & keyof ManualTaxTransactionFormState
>;

const editableManualTaxTransactionIntegerFields = [
  "block_number",
  "token_decimal",
  "is_error",
  "holding_duration_days",
] as const satisfies ReadonlyArray<
  keyof TaxTransactionUpdate & keyof ManualTaxTransactionFormState
>;

export function manualTransactionFormFromTransaction(
  transaction: TaxTransaction,
): ManualTaxTransactionFormState {
  return {
    ...emptyManualTaxTransactionForm,
    hash: transaction.hash,
    block_number: formatNullableNumber(transaction.block_number),
    time_stamp: transaction.time_stamp ?? "",
    from_address: transaction.from_address ?? "",
    to_address: transaction.to_address ?? "",
    value: transaction.value ?? "",
    gas_used: transaction.gas_used ?? "",
    gas_price: transaction.gas_price ?? "",
    fee: transaction.fee ?? "",
    method_id: transaction.method_id ?? "",
    function_name: transaction.function_name ?? "",
    input: transaction.input ?? "",
    contract_address: transaction.contract_address ?? "",
    token_symbol: transaction.token_symbol ?? "",
    token_decimal: formatNullableNumber(transaction.token_decimal),
    token_name: transaction.token_name ?? "",
    is_error: formatNullableNumber(transaction.is_error),
    label: transaction.label ?? "",
    incoming_quantity: transaction.incoming_quantity ?? "",
    incoming_asset: transaction.incoming_asset ?? "",
    outgoing_quantity: transaction.outgoing_quantity ?? "",
    outgoing_asset: transaction.outgoing_asset ?? "",
    cost_eur: transaction.cost_eur ?? "",
    proceeds_eur: transaction.proceeds_eur ?? "",
    gain_eur: transaction.gain_eur ?? "",
    holding_duration_days: formatNullableNumber(transaction.holding_duration_days),
    comment: transaction.comment ?? "",
  };
}

export function buildManualTaxTransactionUpdate(
  transaction: TaxTransaction,
  form: ManualTaxTransactionFormState,
): { update?: TaxTransactionUpdate; error?: string } {
  const update: TaxTransactionUpdate = {};
  const original = manualTransactionFormFromTransaction(transaction);

  for (const field of editableManualTaxTransactionStringFields) {
    if (form[field] !== original[field]) {
      const trimmed = form[field].trim();
      update[field] = (trimmed === "" ? null : trimmed) as never;
    }
  }

  for (const field of editableManualTaxTransactionIntegerFields) {
    if (form[field] !== original[field]) {
      const parsed = parseManualIntegerField(field, form[field]);
      if (parsed.error) return { error: parsed.error };
      update[field] = parsed.value as never;
    }
  }

  if (form.label !== original.label) {
    update.label = form.label === "" ? null : form.label;
  }

  if (Object.keys(update).length === 0) {
    return { error: "Change at least one field before saving." };
  }

  if ("hash" in update && update.hash === null) {
    return { error: "Hash cannot be empty." };
  }

  return { update };
}

function formatNullableNumber(value: number | null): string {
  return value === null ? "" : String(value);
}

function parseManualIntegerField(
  field: (typeof editableManualTaxTransactionIntegerFields)[number],
  value: string,
): { value: number | null; error?: string } {
  const trimmed = value.trim();
  if (trimmed === "") return { value: null };
  if (!/^-?\d+$/.test(trimmed))
    return { value: null, error: `${manualFieldLabel(field)} must be a whole number.` };
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    return { value: null, error: `${manualFieldLabel(field)} must be a safe whole number.` };
  }
  if (field === "holding_duration_days" && parsed < 0) {
    return { value: null, error: "Holding days must be a non-negative whole number." };
  }
  return { value: parsed };
}

function manualFieldLabel(field: string): string {
  return field
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function submitManualTaxTransactionForm({
  form,
  createTransaction,
  setValidationError,
  resetForm,
}: {
  form: ManualTaxTransactionFormState;
  createTransaction: CreateManualTaxTransaction;
  setValidationError: (error: string | null) => void;
  resetForm: () => void;
}) {
  const result = buildManualTaxTransactionCreateInput(form);
  if (result.error || !result.input) {
    setValidationError(result.error ?? "Could not build manual transaction.");
    return;
  }

  createTransaction(result.input, {
    onSuccess: () => {
      resetForm();
      setValidationError(null);
    },
  });
}

function addTrimmedField(
  input: ManualTaxTransactionCreateInput,
  field: keyof ManualTaxTransactionCreateInput,
  value: string,
) {
  const trimmed = value.trim();
  if (trimmed !== "") {
    input[field] = trimmed as never;
  }
}

export function isManualTaxTransaction(transaction: TaxTransaction): boolean {
  return transaction.source === "manual";
}

export type TaxTransactionControlTarget = Pick<TaxTransaction, "id" | "hash" | "comment"> & {
  label: TaxTransactionLabel | "mixed";
};

export function groupTaxTransactions(transactions: TaxTransaction[]): TaxTransactionGroup[] {
  const groups = new Map<string, TaxTransactionGroup>();

  for (const transaction of transactions) {
    // Hedge close and funding rows share an event key (hedge:close:tid:coin:hash vs
    // hedge:funding:tid:coin:hash) — group them together under the same key so they
    // appear as a single expandable row rather than two unrelated entries.
    const hedgeMatch = transaction.id.match(/^hedge:(?:close|funding):(.+?)(?::funding)?$/);
    const groupKey = hedgeMatch ? `hedge:event:${hedgeMatch[1]}` : transaction.hash;

    const existing = groups.get(groupKey);
    if (existing) {
      existing.transactions.push(transaction);
      continue;
    }

    groups.set(groupKey, {
      id: hedgeMatch ? groupKey : `hash:${transaction.hash}`,
      hash: transaction.hash,
      primary: transaction,
      transactions: [transaction],
    });
  }

  return sortTaxTransactionGroupsNewestFirst([...groups.values()]);
}

function sortTaxTransactionGroupsNewestFirst(groups: TaxTransactionGroup[]): TaxTransactionGroup[] {
  const sorted: TaxTransactionGroup[] = [];
  for (const group of groups) {
    const insertIndex = sorted.findIndex(
      (existing) => compareTaxTransactionGroupsByNewestFirst(group, existing) < 0,
    );
    if (insertIndex === -1) {
      sorted.push(group);
    } else {
      sorted.splice(insertIndex, 0, group);
    }
  }
  return sorted;
}

function compareTaxTransactionGroupsByNewestFirst(
  left: TaxTransactionGroup,
  right: TaxTransactionGroup,
): number {
  const leftTime = taxTransactionSortTime(left.primary);
  const rightTime = taxTransactionSortTime(right.primary);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return (right.primary.block_number ?? -1) - (left.primary.block_number ?? -1);
}

function taxTransactionSortTime(transaction: TaxTransaction): number {
  if (!transaction.time_stamp) return Number.NEGATIVE_INFINITY;

  const numeric = Number(transaction.time_stamp);
  const time = Number.isFinite(numeric)
    ? numeric * 1000
    : new Date(transaction.time_stamp).getTime();
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

export function updateTaxTransactionGroup(
  group: TaxTransactionGroup,
  update: TaxTransactionUpdate,
  updateTransaction: UpdateTaxTransaction,
) {
  for (const transaction of group.transactions) {
    updateTransaction(transaction.id, update);
  }
}

export function TaxTransactions() {
  const { data: transactions, error, isLoading, isFetching } = useTaxTransactions({ limit: 200 });
  const createMutation = useCreateTaxTransaction();
  const syncMutation = useSyncTaxTransactions();
  const updateMutation = useUpdateTaxTransaction();

  return (
    <main className="min-h-screen bg-white text-neutral-950">
      <section className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-4 sm:px-6 lg:px-8">
        <header className="overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-sm">
          <div className="border-b border-neutral-200 px-5 py-3 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3 text-[0.68rem] font-semibold tracking-[0.22em] text-neutral-500 uppercase">
              <span>HyperEVM ProjectX</span>
              <a className="text-neutral-700 transition hover:text-neutral-950" href="/">
                Portfolio Dashboard
              </a>
            </div>
          </div>
          <div className="p-5 sm:p-7">
            <div>
              <p className="text-xs font-semibold tracking-[0.35em] text-neutral-500 uppercase">
                Tax Operations
              </p>
              <h1 className="mt-3 max-w-4xl text-4xl font-black tracking-[-0.04em] text-neutral-950 sm:text-6xl lg:text-7xl">
                Transaction Labeling Ledger
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-6 text-neutral-600 sm:text-base">
                Review synced wallet activity, classify tax intent, and add notes for downstream
                reconciliation. Sync runs only when requested.
              </p>
            </div>
          </div>
        </header>

        {isLoading ? <TaxLoadingState /> : null}
        {error ? <TaxErrorState error={error} /> : null}
        {!isLoading && !error && transactions ? (
          <TaxTransactionLedger
            transactions={transactions}
            createTransaction={(input, options) => createMutation.mutate(input, options)}
            createError={createMutation.error}
            isCreating={createMutation.isPending}
            isCreateSuccess={createMutation.isSuccess}
            syncMutation={syncMutation}
            isSyncFetching={isFetching && !isLoading}
            updateTransaction={(id, update) => updateMutation.mutate({ id, update })}
            updateError={updateMutation.error}
            isUpdating={updateMutation.isPending}
          />
        ) : null}
      </section>
    </main>
  );
}

export function TaxTransactionLedger({
  transactions,
  createTransaction = () => undefined,
  createError,
  isCreating,
  isCreateSuccess,
  syncMutation = idleTaxSyncMutation,
  isSyncFetching = false,
  updateTransaction,
  updateError,
  isUpdating,
  defaultExpandedGroups = [],
  defaultSorting,
  defaultColumnVisibility,
}: {
  transactions: TaxTransaction[];
  createTransaction?: CreateManualTaxTransaction;
  createError?: unknown;
  isCreating?: boolean;
  isCreateSuccess?: boolean;
  syncMutation?: {
    mutate: () => void;
    data?: Record<string, unknown>;
    error?: unknown;
    isError: boolean;
    isPending: boolean;
    isSuccess: boolean;
  };
  isSyncFetching?: boolean;
  updateTransaction: UpdateTaxTransaction;
  updateError?: unknown;
  isUpdating?: boolean;
  defaultExpandedGroups?: string[];
  defaultSorting?: SortingState;
  defaultColumnVisibility?: VisibilityState;
}) {
  const groups = groupTaxTransactions(transactions);
  const [expandedGroups, setExpandedGroups] = useState<ExpandedState>(() => {
    const state: Record<string, boolean> = {};
    for (const groupId of defaultExpandedGroups) {
      state[groupId] = true;
    }
    return state;
  });

  const tableData = useMemo(() => buildTableRows(transactions), [transactions]);
  const [sorting, setSorting] = useState<SortingState>(() => defaultSorting ?? []);

  const STORAGE_KEY = "tax-ledger-column-visibility";
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => {
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          return { ...defaultColumnVisibility, ...JSON.parse(stored) };
        }
      } catch {
        // ignore
      }
    }
    return defaultColumnVisibility ?? {};
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(columnVisibility));
    } catch {
      // ignore
    }
  }, [columnVisibility]);

  const [showColumnMenu, setShowColumnMenu] = useState(false);

  const table = useReactTable<TaxTableRow>({
    data: tableData,
    columns: taxTableColumns,
    state: { sorting, columnVisibility, expanded: expandedGroups },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onExpandedChange: setExpandedGroups,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getSubRows: (row) => row.subRows,
    getRowId: (row) => (row.groupData ? `hash:${row.hash}` : row.id),
    meta: { updateTransaction, isUpdating } satisfies TableMeta,
  });

  return (
    <section className="overflow-x-clip rounded-3xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-5 py-4">
        <div>
          <p className="text-[0.65rem] font-semibold tracking-[0.28em] text-neutral-500 uppercase">
            Tax Blotter
          </p>
          <h2 className="mt-1 text-lg font-bold text-neutral-950">Synced Transactions</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="rounded-full border border-neutral-300 bg-white px-4 py-2 text-xs font-bold text-neutral-700 transition hover:border-neutral-950 hover:text-neutral-950 disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-400"
            disabled={syncMutation.isPending}
            type="button"
            onClick={() => syncMutation.mutate()}
          >
            {syncMutation.isPending ? "Syncing..." : "Sync blockchain data"}
          </button>
          <ManualTaxTransactionForm
            createTransaction={createTransaction}
            createError={createError}
            isCreating={isCreating}
            isSuccess={isCreateSuccess}
          />
          <span className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs font-semibold text-neutral-600">
            {groups.length} {groups.length === 1 ? "transaction" : "transactions"}
          </span>
        </div>
      </div>
      <SyncStatus mutation={syncMutation} isFetching={isSyncFetching} />
      {updateError ? (
        <div className="border-b border-neutral-200 bg-neutral-50 px-5 py-3 text-sm font-semibold text-neutral-700">
          Could not save transaction metadata: {errorMessage(updateError)}
        </div>
      ) : null}
      {transactions.length === 0 ? <TaxEmptyState /> : null}
      {transactions.length > 0 ? (
        <>
          <div className="relative mb-2 flex justify-end px-5 pt-3">
            <button
              type="button"
              onClick={() => setShowColumnMenu((v) => !v)}
              className="rounded border border-neutral-300 bg-white px-3 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-800"
            >
              Columns
            </button>
            {showColumnMenu && (
              <div className="absolute top-10 right-5 z-10 rounded border border-neutral-300 bg-white p-3 shadow-lg dark:border-neutral-600 dark:bg-neutral-800">
                {table.getAllLeafColumns().map((column) => (
                  <label
                    key={column.id}
                    className="flex cursor-pointer items-center gap-2 py-1 text-sm"
                  >
                    <input
                      type="checkbox"
                      aria-label={
                        typeof column.columnDef.header === "string"
                          ? column.columnDef.header
                          : column.id
                      }
                      checked={column.getIsVisible()}
                      onChange={column.getToggleVisibilityHandler()}
                    />
                    {typeof column.columnDef.header === "string"
                      ? column.columnDef.header
                      : column.id}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="hidden lg:block">
            <table className="w-full table-fixed divide-y divide-neutral-200 text-sm">
              <colgroup>
                {table.getVisibleLeafColumns().map((column) => (
                  <col key={column.id} style={{ width: `${column.getSize()}%` }} />
                ))}
              </colgroup>
              <thead className="text-left text-[0.68rem] tracking-[0.18em] text-neutral-500 uppercase">
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        className={`sticky top-0 z-10 bg-neutral-50 px-2 py-3 shadow-sm${header.column.getCanSort() ? " cursor-pointer select-none" : ""}`}
                        aria-sort={
                          header.column.getCanSort()
                            ? header.column.getIsSorted() === "asc"
                              ? "ascending"
                              : header.column.getIsSorted() === "desc"
                                ? "descending"
                                : "none"
                            : undefined
                        }
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {header.isPlaceholder ? null : (
                          <>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {header.column.getCanSort() && (
                              <span aria-hidden="true" className="ml-1 inline-block text-xs">
                                {header.column.getIsSorted() === "asc"
                                  ? "▲"
                                  : header.column.getIsSorted() === "desc"
                                    ? "▼"
                                    : "⇅"}
                              </span>
                            )}
                          </>
                        )}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody className="divide-y divide-neutral-200">
                {table.getRowModel().rows.map((row) => {
                  const isGroupChild = row.depth > 0;
                  const isLastGroupChild =
                    isGroupChild && row.index === (row.getParentRow()?.subRows.length ?? 1) - 1;

                  const firstCellConnectorClass = isGroupChild
                    ? isLastGroupChild
                      ? "before:absolute before:top-0 before:left-5 before:h-7 before:w-px before:bg-neutral-300 after:absolute after:top-7 after:left-5 after:h-px after:w-4 after:bg-neutral-300"
                      : "before:absolute before:top-0 before:bottom-0 before:left-5 before:w-px before:bg-neutral-300 after:absolute after:top-7 after:left-5 after:h-px after:w-4 after:bg-neutral-300"
                    : "";

                  return (
                    <tr
                      key={row.id}
                      className={`align-top text-neutral-700 transition hover:bg-neutral-50 ${isGroupChild ? "bg-neutral-50/60" : ""}`}
                    >
                      {row.getVisibleCells().map((cell, cellIndex) => {
                        const isFirstCell = cellIndex === 0;

                        if (isFirstCell && isGroupChild) {
                          return (
                            <td
                              key={cell.id}
                              className={`relative py-4 pr-2 pl-2 font-mono text-xs font-bold text-neutral-950 ${firstCellConnectorClass}`}
                            >
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </td>
                          );
                        }

                        if (isFirstCell) {
                          return (
                            <td
                              key={cell.id}
                              className="py-4 pr-2 pl-2 font-mono text-xs font-bold text-neutral-950"
                            >
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </td>
                          );
                        }

                        return (
                          <td key={cell.id} className="px-2 py-4">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="divide-y divide-neutral-200 lg:hidden">
            {groups.map((group) => {
              if (group.transactions.length === 1) {
                return (
                  <TaxTransactionCard
                    key={group.primary.id}
                    transaction={group.primary}
                    updateTransaction={updateTransaction}
                    isUpdating={isUpdating}
                  />
                );
              }

              const tanstackRow = table.getRow(group.id);
              const isExpanded = tanstackRow?.getIsExpanded() ?? false;
              return (
                <TaxTransactionGroupCard
                  key={group.id}
                  group={group}
                  isExpanded={isExpanded}
                  isUpdating={isUpdating}
                  updateTransaction={updateTransaction}
                  toggleGroup={() => tanstackRow?.toggleExpanded()}
                />
              );
            })}
          </div>
        </>
      ) : null}
    </section>
  );
}

export function ManualTaxTransactionForm({
  createTransaction,
  createError,
  isCreating,
  isSuccess,
  initialForm = emptyManualTaxTransactionForm,
  initialIsOpen = false,
}: {
  createTransaction: CreateManualTaxTransaction;
  createError?: unknown;
  isCreating?: boolean;
  isSuccess?: boolean;
  initialForm?: ManualTaxTransactionFormState;
  initialIsOpen?: boolean;
}) {
  const [form, setForm] = useState<ManualTaxTransactionFormState>(initialForm);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(initialIsOpen);

  function updateField(field: keyof ManualTaxTransactionFormState, value: string) {
    setValidationError(null);
    setForm((current) => ({ ...current, [field]: value }));
  }

  function closeModal() {
    if (isCreating) return;
    setForm(emptyManualTaxTransactionForm);
    setValidationError(null);
    setIsOpen(false);
  }

  return (
    <>
      <div>
        <button
          className="rounded-full bg-neutral-950 px-4 py-2 text-xs font-bold text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
          disabled={isCreating}
          type="button"
          onClick={() => setIsOpen(true)}
        >
          Add manual transaction
        </button>
      </div>
      {isOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-neutral-950/45 p-4">
          <dialog
            aria-labelledby="manual-create-title"
            aria-modal="true"
            className="fixed top-1/2 left-1/2 m-0 max-h-[90vh] w-[calc(100vw-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border border-neutral-200 bg-white p-0 text-neutral-950 shadow-2xl"
            open
          >
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-neutral-200 bg-white px-5 py-4">
              <div>
                <p className="text-[0.65rem] font-semibold tracking-[0.28em] text-neutral-500 uppercase">
                  Manual Entry
                </p>
                <h2 className="mt-1 text-lg font-bold text-neutral-950" id="manual-create-title">
                  Add Tax Transaction
                </h2>
              </div>
              <button
                aria-label="Close manual transaction creator"
                className="rounded-full border border-neutral-300 bg-white px-4 py-2 text-xs font-bold text-neutral-700 transition hover:border-neutral-950 hover:text-neutral-950 disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-400"
                disabled={isCreating}
                type="button"
                onClick={closeModal}
              >
                Close
              </button>
            </div>
            <form
              className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4"
              onSubmit={(event) => {
                event.preventDefault();
                submitManualTaxTransactionForm({
                  form,
                  createTransaction,
                  setValidationError,
                  resetForm: () => setForm(emptyManualTaxTransactionForm),
                });
              }}
            >
              <ManualTextInput
                label="ID"
                value={form.id}
                disabled={isCreating}
                placeholder="Optional manual id"
                onChange={(value) => updateField("id", value)}
              />
              <ManualTextInput
                label="Hash"
                value={form.hash}
                disabled={isCreating}
                placeholder="Optional transaction hash"
                onChange={(value) => updateField("hash", value)}
              />
              <ManualTextInput
                label="Time"
                value={form.time_stamp}
                disabled={isCreating}
                placeholder="2026-05-30T12:00:00Z"
                onChange={(value) => updateField("time_stamp", value)}
              />
              <ManualTextInput
                label="Block"
                value={form.block_number}
                disabled={isCreating}
                inputMode="numeric"
                placeholder="Optional block"
                onChange={(value) => updateField("block_number", value)}
              />
              <label className="grid gap-2">
                <span className="text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-500 uppercase">
                  Label
                </span>
                <select
                  className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm font-semibold text-neutral-950 transition outline-none focus:border-neutral-950 disabled:bg-neutral-100 disabled:text-neutral-500"
                  disabled={isCreating}
                  value={form.label}
                  onChange={(event) => updateField("label", event.currentTarget.value)}
                >
                  {taxTransactionLabelOptions.map((option) => (
                    <option key={option.label} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <ManualTextInput
                label="Incoming Qty"
                value={form.incoming_quantity}
                disabled={isCreating}
                placeholder="1.5"
                onChange={(value) => updateField("incoming_quantity", value)}
              />
              <ManualTextInput
                label="Fee"
                value={form.fee}
                disabled={isCreating}
                placeholder="Gas or exchange fee"
                onChange={(value) => updateField("fee", value)}
              />
              <ManualTextInput
                label="Incoming Asset"
                value={form.incoming_asset}
                disabled={isCreating}
                placeholder="HYPE"
                onChange={(value) => updateField("incoming_asset", value)}
              />
              <ManualTextInput
                label="Outgoing Qty"
                value={form.outgoing_quantity}
                disabled={isCreating}
                placeholder="42.00"
                onChange={(value) => updateField("outgoing_quantity", value)}
              />
              <ManualTextInput
                label="Outgoing Asset"
                value={form.outgoing_asset}
                disabled={isCreating}
                placeholder="USDC"
                onChange={(value) => updateField("outgoing_asset", value)}
              />
              <ManualTextInput
                label="Cost EUR"
                value={form.cost_eur}
                disabled={isCreating}
                placeholder="1000.00"
                onChange={(value) => updateField("cost_eur", value)}
              />
              <ManualTextInput
                label="Proceeds EUR"
                value={form.proceeds_eur}
                disabled={isCreating}
                placeholder="1100.00"
                onChange={(value) => updateField("proceeds_eur", value)}
              />
              <ManualTextInput
                label="Gain EUR"
                value={form.gain_eur}
                disabled={isCreating}
                placeholder="100.00"
                onChange={(value) => updateField("gain_eur", value)}
              />
              <ManualTextInput
                label="Holding Days"
                value={form.holding_duration_days}
                disabled={isCreating}
                inputMode="numeric"
                placeholder="42"
                onChange={(value) => updateField("holding_duration_days", value)}
              />
              <label className="grid gap-2 sm:col-span-2 lg:col-span-4">
                <span className="text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-500 uppercase">
                  Comment
                </span>
                <textarea
                  aria-label="Manual transaction comment"
                  className="min-h-24 w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-950 transition outline-none placeholder:text-neutral-400 focus:border-neutral-950 disabled:bg-neutral-100 disabled:text-neutral-500"
                  disabled={isCreating}
                  placeholder="Manual note or reconciliation context"
                  value={form.comment}
                  onChange={(event) => updateField("comment", event.currentTarget.value)}
                />
              </label>
              <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-4">
                <button
                  className="rounded-full bg-neutral-950 px-5 py-3 text-sm font-bold text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
                  disabled={isCreating}
                  type="submit"
                >
                  {isCreating ? "Creating..." : "Create manual transaction"}
                </button>
                {validationError ? (
                  <p className="text-sm font-semibold text-neutral-700">{validationError}</p>
                ) : null}
                {createError ? (
                  <p className="text-sm font-semibold text-neutral-700">
                    Could not create transaction: {errorMessage(createError)}
                  </p>
                ) : null}
                {isSuccess && !createError && !validationError ? (
                  <p className="text-sm font-semibold text-neutral-600">
                    Manual transaction created. Refreshing ledger...
                  </p>
                ) : null}
              </div>
            </form>
          </dialog>
        </div>
      ) : null}
    </>
  );
}

function ManualTextInput({
  label,
  value,
  disabled,
  placeholder,
  inputMode,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  inputMode?: "numeric";
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-2">
      <span className="text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-500 uppercase">
        {label}
      </span>
      <input
        aria-label={label}
        className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-950 transition outline-none placeholder:text-neutral-400 focus:border-neutral-950 disabled:bg-neutral-100 disabled:text-neutral-500"
        disabled={disabled}
        inputMode={inputMode}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function TaxTransactionGroupCard({
  group,
  updateTransaction,
  isUpdating,
  isExpanded,
  toggleGroup,
}: {
  group: TaxTransactionGroup;
  updateTransaction: UpdateTaxTransaction;
  isUpdating?: boolean;
  isExpanded: boolean;
  toggleGroup: () => void;
}) {
  const parentControlTarget = groupControlTarget(group);
  const updateGroup = (update: TaxTransactionUpdate) =>
    updateTaxTransactionGroup(group, update, updateTransaction);

  return (
    <article className="p-5 text-sm text-neutral-700">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <TransactionHashLink hash={group.hash} />
          <p className="mt-1 text-xs font-semibold text-neutral-500">
            {formatTimestamp(group.primary.time_stamp)} / Block{" "}
            {group.primary.block_number ?? "n/a"}
          </p>
        </div>
        <span className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-xs font-bold text-neutral-600">
          {group.transactions.length} parts
        </span>
      </div>
      <div className="mt-4 rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
        <p className="text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-500 uppercase">
          Grouped Trade
        </p>
        <p className="mt-1 font-mono font-bold text-neutral-950">
          {formatGroupValueSummary(group)}
        </p>
        <p className="mt-1 text-xs font-semibold text-neutral-500">{groupLabel(group)}</p>
        <div className="mt-4">
          <TaxDetail label="Fee" value={formatGroupFee(group)} />
        </div>
      </div>
      <div className="mt-4 grid gap-3 rounded-2xl border border-neutral-200 bg-neutral-50 p-4 sm:grid-cols-[180px_1fr]">
        <div>
          <LabelSelect
            transaction={parentControlTarget}
            updateTransaction={(_id, update) => updateGroup(update)}
            disabled={isUpdating}
          />
          <p className="mt-2 text-xs font-semibold text-neutral-500">Applies to all parts</p>
        </div>
        <CommentEditor
          transaction={parentControlTarget}
          updateTransaction={(_id, update) => updateGroup(update)}
          disabled={isUpdating}
          mixedComment={hasMixedGroupComments(group)}
        />
      </div>
      <button
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? "Hide" : "Show"} transaction parts for ${group.hash}`}
        className="mt-4 rounded-full border border-neutral-300 bg-white px-4 py-2 text-xs font-bold text-neutral-700 transition hover:border-neutral-950 hover:text-neutral-950"
        type="button"
        onClick={toggleGroup}
      >
        {isExpanded ? "Hide transaction parts" : "Show transaction parts"}
      </button>
      {isExpanded ? (
        <div className="mt-4 divide-y divide-neutral-200 overflow-hidden rounded-2xl border border-neutral-200 bg-white">
          {group.transactions.map((transaction, index) => (
            <div
              key={transaction.id}
              className={`relative pl-5 before:absolute before:top-0 before:left-2 before:w-px before:bg-neutral-300 after:absolute after:top-8 after:left-2 after:h-px after:w-3 after:bg-neutral-300 ${index === group.transactions.length - 1 ? "before:h-8" : "before:bottom-0"}`}
            >
              <TaxTransactionCard
                transaction={transaction}
                updateTransaction={updateTransaction}
                isUpdating={isUpdating}
                suppressFee
              />
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function TaxTransactionCard({
  transaction,
  updateTransaction,
  isUpdating,
  suppressFee = false,
}: {
  transaction: TaxTransaction;
  updateTransaction: UpdateTaxTransaction;
  isUpdating?: boolean;
  suppressFee?: boolean;
}) {
  return (
    <article className="p-5 text-sm text-neutral-700">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <TransactionHashLink hash={transaction.hash} />
          <p className="mt-1 text-xs font-semibold text-neutral-500">
            {formatTimestamp(transaction.time_stamp)} / Block {transaction.block_number ?? "n/a"}
          </p>
        </div>
        <span className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-xs font-bold text-neutral-600">
          {transaction.label ?? "Unlabeled"}
        </span>
      </div>
      <div className="mt-4 grid gap-3 rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
        <AddressLine label="From" value={transaction.from_address} />
        <AddressLine label="To" value={transaction.to_address} />
        <div>
          <p className="text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-500 uppercase">
            Value / Function
          </p>
          <p className="mt-1 font-mono font-bold text-neutral-950">
            {formatTransactionValue(transaction)}
          </p>
          <p className="mt-1 text-xs font-semibold text-neutral-500">
            {functionLabel(transaction)}
          </p>
        </div>
        <TaxDetail label="Incoming Qty" value={transaction.incoming_quantity} />
        <TaxDetail label="Incoming Asset" value={transaction.incoming_asset} />
        <TaxDetail label="Outgoing Qty" value={transaction.outgoing_quantity} />
        <TaxDetail label="Outgoing Asset" value={transaction.outgoing_asset} />
        <TaxDetail label="Fee" value={suppressFee ? null : formatFee(transaction.fee)} />
        <TaxDetail label="Cost EUR" value={transaction.cost_eur} />
        <TaxDetail label="Proceeds EUR" value={transaction.proceeds_eur} />
        <TaxDetail label="Gain EUR" value={transaction.gain_eur} />
        <TaxDetail label="Holding Days" value={transaction.holding_duration_days} />
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-[180px_1fr]">
        {isManualTaxTransaction(transaction) ? (
          <ManualTransactionEditor
            transaction={transaction}
            updateTransaction={updateTransaction}
            disabled={isUpdating}
          />
        ) : (
          <LabelSelect
            transaction={transaction}
            updateTransaction={updateTransaction}
            disabled={isUpdating}
          />
        )}
        <CommentEditor
          transaction={transaction}
          updateTransaction={updateTransaction}
          disabled={isUpdating}
        />
      </div>
    </article>
  );
}

export function LabelSelect({
  transaction,
  updateTransaction,
  disabled,
}: {
  transaction: TaxTransactionControlTarget;
  updateTransaction: (id: string, update: { label?: TaxTransactionLabel }) => void;
  disabled?: boolean;
}) {
  const value = transaction.label === "mixed" ? "mixed" : (transaction.label ?? "");

  return (
    <select
      className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm font-semibold text-neutral-950 transition outline-none focus:border-neutral-950 disabled:bg-neutral-100 disabled:text-neutral-500"
      data-transaction-id={transaction.id}
      disabled={disabled}
      value={value}
      onChange={(event) => {
        const selectedLabel = event.currentTarget.value as "" | NonNullable<TaxTransactionLabel>;
        updateTransaction(transaction.id, { label: selectedLabel === "" ? null : selectedLabel });
      }}
    >
      {transaction.label === "mixed" ? (
        <option value="mixed" disabled>
          Mixed labels
        </option>
      ) : null}
      {taxTransactionLabelOptions.map((option) => (
        <option key={option.label} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function ManualTransactionEditor({
  transaction,
  updateTransaction,
  disabled,
  initialIsEditing = false,
}: {
  transaction: TaxTransaction;
  updateTransaction: UpdateTaxTransaction;
  disabled?: boolean;
  initialIsEditing?: boolean;
}) {
  const [isEditing, setIsEditing] = useState(initialIsEditing);
  const [form, setForm] = useState(() => manualTransactionFormFromTransaction(transaction));
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setForm(manualTransactionFormFromTransaction(transaction));
    setValidationError(null);
  }, [transaction]);

  function updateField(field: keyof ManualTaxTransactionFormState, value: string) {
    setValidationError(null);
    setForm((current) => ({ ...current, [field]: value }));
  }

  function save() {
    const result = buildManualTaxTransactionUpdate(transaction, form);
    if (result.error || !result.update) {
      setValidationError(result.error ?? "Could not build manual transaction update.");
      return;
    }
    updateTransaction(transaction.id, result.update);
    setIsEditing(false);
  }

  return (
    <div className="grid gap-2">
      <LabelSelect
        transaction={transaction}
        updateTransaction={updateTransaction}
        disabled={disabled}
      />
      <button
        className="justify-self-start rounded-full border border-neutral-300 bg-white px-4 py-2 text-xs font-bold text-neutral-700 transition hover:border-neutral-950 hover:text-neutral-950 disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-400"
        disabled={disabled}
        type="button"
        onClick={() => setIsEditing(true)}
      >
        Edit manual fields
      </button>
      {isEditing ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-neutral-950/45 p-4">
          <dialog
            aria-labelledby={`manual-editor-title-${transaction.id}`}
            aria-modal="true"
            className="fixed top-1/2 left-1/2 m-0 max-h-[90vh] w-[calc(100vw-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border border-neutral-200 bg-white p-0 text-neutral-950 shadow-2xl"
            open
          >
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-neutral-200 bg-white px-5 py-4">
              <div>
                <p className="text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-500 uppercase">
                  Manual Fields
                </p>
                <h3
                  className="mt-1 text-lg font-bold text-neutral-950"
                  id={`manual-editor-title-${transaction.id}`}
                >
                  Edit manual transaction
                </h3>
                <p className="mt-1 font-mono text-xs break-all text-neutral-500">
                  {transaction.id}
                </p>
              </div>
              <button
                aria-label="Close manual transaction editor"
                className="rounded-full border border-neutral-300 bg-white px-4 py-2 text-xs font-bold text-neutral-700 transition hover:border-neutral-950 hover:text-neutral-950 disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-400"
                disabled={disabled}
                type="button"
                onClick={() => {
                  setForm(manualTransactionFormFromTransaction(transaction));
                  setValidationError(null);
                  setIsEditing(false);
                }}
              >
                Close
              </button>
            </div>
            <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
              <ManualEditInput
                label="Hash"
                value={form.hash}
                disabled={disabled}
                onChange={(value) => updateField("hash", value)}
              />
              <ManualEditInput
                label="Time"
                value={form.time_stamp}
                disabled={disabled}
                onChange={(value) => updateField("time_stamp", value)}
              />
              <ManualEditInput
                label="Block"
                value={form.block_number}
                disabled={disabled}
                inputMode="numeric"
                onChange={(value) => updateField("block_number", value)}
              />
              <ManualEditInput
                label="From"
                value={form.from_address}
                disabled={disabled}
                onChange={(value) => updateField("from_address", value)}
              />
              <ManualEditInput
                label="To"
                value={form.to_address}
                disabled={disabled}
                onChange={(value) => updateField("to_address", value)}
              />
              <ManualEditInput
                label="Value"
                value={form.value}
                disabled={disabled}
                onChange={(value) => updateField("value", value)}
              />
              <ManualEditInput
                label="Gas Used"
                value={form.gas_used}
                disabled={disabled}
                onChange={(value) => updateField("gas_used", value)}
              />
              <ManualEditInput
                label="Gas Price"
                value={form.gas_price}
                disabled={disabled}
                onChange={(value) => updateField("gas_price", value)}
              />
              <ManualEditInput
                label="Incoming Qty"
                value={form.incoming_quantity}
                disabled={disabled}
                onChange={(value) => updateField("incoming_quantity", value)}
              />
              <ManualEditInput
                label="Incoming Asset"
                value={form.incoming_asset}
                disabled={disabled}
                onChange={(value) => updateField("incoming_asset", value)}
              />
              <ManualEditInput
                label="Outgoing Qty"
                value={form.outgoing_quantity}
                disabled={disabled}
                onChange={(value) => updateField("outgoing_quantity", value)}
              />
              <ManualEditInput
                label="Outgoing Asset"
                value={form.outgoing_asset}
                disabled={disabled}
                onChange={(value) => updateField("outgoing_asset", value)}
              />
              <ManualEditInput
                label="Fee"
                value={form.fee}
                disabled={disabled}
                onChange={(value) => updateField("fee", value)}
              />
              <ManualEditInput
                label="Method ID"
                value={form.method_id}
                disabled={disabled}
                onChange={(value) => updateField("method_id", value)}
              />
              <ManualEditInput
                label="Function"
                value={form.function_name}
                disabled={disabled}
                onChange={(value) => updateField("function_name", value)}
              />
              <ManualEditInput
                label="Input"
                value={form.input}
                disabled={disabled}
                onChange={(value) => updateField("input", value)}
              />
              <ManualEditInput
                label="Contract"
                value={form.contract_address}
                disabled={disabled}
                onChange={(value) => updateField("contract_address", value)}
              />
              <ManualEditInput
                label="Token Symbol"
                value={form.token_symbol}
                disabled={disabled}
                onChange={(value) => updateField("token_symbol", value)}
              />
              <ManualEditInput
                label="Token Decimals"
                value={form.token_decimal}
                disabled={disabled}
                inputMode="numeric"
                onChange={(value) => updateField("token_decimal", value)}
              />
              <ManualEditInput
                label="Token Name"
                value={form.token_name}
                disabled={disabled}
                onChange={(value) => updateField("token_name", value)}
              />
              <ManualEditInput
                label="Is Error"
                value={form.is_error}
                disabled={disabled}
                inputMode="numeric"
                onChange={(value) => updateField("is_error", value)}
              />
              <ManualEditInput
                label="Cost EUR"
                value={form.cost_eur}
                disabled={disabled}
                onChange={(value) => updateField("cost_eur", value)}
              />
              <ManualEditInput
                label="Proceeds EUR"
                value={form.proceeds_eur}
                disabled={disabled}
                onChange={(value) => updateField("proceeds_eur", value)}
              />
              <ManualEditInput
                label="Gain EUR"
                value={form.gain_eur}
                disabled={disabled}
                onChange={(value) => updateField("gain_eur", value)}
              />
              <ManualEditInput
                label="Holding Days"
                value={form.holding_duration_days}
                disabled={disabled}
                inputMode="numeric"
                onChange={(value) => updateField("holding_duration_days", value)}
              />
              <label className="grid gap-2">
                <span className="text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-500 uppercase">
                  Label
                </span>
                <select
                  className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs font-semibold text-neutral-950 transition outline-none focus:border-neutral-950 disabled:bg-neutral-100 disabled:text-neutral-500"
                  disabled={disabled}
                  value={form.label}
                  onChange={(event) => updateField("label", event.currentTarget.value)}
                >
                  {taxTransactionLabelOptions.map((option) => (
                    <option key={option.label} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-2 sm:col-span-2 lg:col-span-3">
                <span className="text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-500 uppercase">
                  Comment
                </span>
                <textarea
                  aria-label="Manual Comment"
                  className="min-h-16 w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs text-neutral-950 transition outline-none placeholder:text-neutral-400 focus:border-neutral-950 disabled:bg-neutral-100 disabled:text-neutral-500"
                  disabled={disabled}
                  value={form.comment}
                  onChange={(event) => updateField("comment", event.currentTarget.value)}
                />
              </label>
              <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-3">
                <button
                  className="rounded-full bg-neutral-950 px-4 py-2 text-xs font-bold text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
                  disabled={disabled}
                  type="button"
                  onClick={save}
                >
                  Save manual fields
                </button>
                {validationError ? (
                  <p className="text-xs font-semibold text-neutral-700">{validationError}</p>
                ) : null}
              </div>
            </div>
          </dialog>
        </div>
      ) : null}
    </div>
  );
}

function ManualEditInput({
  label,
  value,
  disabled,
  inputMode,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  inputMode?: "numeric";
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-2">
      <span className="text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-500 uppercase">
        {label}
      </span>
      <input
        aria-label={`Manual ${label}`}
        className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs text-neutral-950 transition outline-none placeholder:text-neutral-400 focus:border-neutral-950 disabled:bg-neutral-100 disabled:text-neutral-500"
        disabled={disabled}
        inputMode={inputMode}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

export function CommentEditor({
  transaction,
  updateTransaction,
  disabled,
  mixedComment = false,
}: {
  transaction: Pick<TaxTransaction, "id" | "hash" | "comment">;
  updateTransaction: (id: string, update: { comment?: string | null }) => void;
  disabled?: boolean;
  mixedComment?: boolean;
}) {
  const [comment, setComment] = useState(transaction.comment ?? "");

  useEffect(() => {
    setComment(transaction.comment ?? "");
  }, [transaction.comment]);

  const commentDraft = taxCommentDraftState(transaction.comment, comment);

  return (
    <div className="grid gap-2">
      <textarea
        aria-label={`Comment for ${transaction.hash}`}
        className="min-h-20 w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-950 transition outline-none placeholder:text-neutral-400 focus:border-neutral-950 disabled:bg-neutral-100 disabled:text-neutral-500"
        data-transaction-id={transaction.id}
        disabled={disabled}
        placeholder={mixedComment ? "Mixed notes; type to replace all" : "Add tax note"}
        value={comment}
        onChange={(event) => setComment(event.currentTarget.value)}
      />
      <button
        className="justify-self-start rounded-full border border-neutral-300 bg-white px-4 py-2 text-xs font-bold text-neutral-700 transition hover:border-neutral-950 hover:text-neutral-950 disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-400"
        data-transaction-id={transaction.id}
        disabled={disabled || !commentDraft.isDirty}
        type="button"
        onClick={() => updateTransaction(transaction.id, { comment: commentDraft.update })}
      >
        Save comment
      </button>
    </div>
  );
}

function TaxDetail({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div>
      <p className="text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-500 uppercase">
        {label}
      </p>
      <p className="mt-1 font-mono font-bold text-neutral-950">{formatTaxLedgerValue(value)}</p>
    </div>
  );
}

export function SyncStatus({
  mutation,
  isFetching,
}: {
  mutation: {
    data?: Record<string, unknown>;
    error?: unknown;
    isError: boolean;
    isPending: boolean;
    isSuccess: boolean;
  };
  isFetching: boolean;
}) {
  if (mutation.isPending) {
    return (
      <p className="mt-3 text-xs font-semibold text-neutral-600">Sync request is running...</p>
    );
  }

  if (mutation.isError) {
    return (
      <p className="mt-3 text-xs font-semibold text-neutral-600">
        Sync failed: {errorMessage(mutation.error)}
      </p>
    );
  }

  if (mutation.isSuccess && mutation.data) {
    return (
      <p className="mt-3 text-xs font-semibold text-neutral-600">
        Sync complete{formatSyncCount(mutation.data)}.{" "}
        {isFetching ? "Refreshing list..." : "List refreshed."}
      </p>
    );
  }

  return null;
}

export function TaxLoadingState() {
  return (
    <div className="rounded-3xl border border-neutral-200 bg-white p-8 text-neutral-600 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-neutral-950" />
        Loading tax transactions...
      </div>
    </div>
  );
}

export function TaxErrorState({ error }: { error: unknown }) {
  return (
    <div className="rounded-3xl border border-neutral-300 bg-neutral-50 p-8 shadow-sm">
      <h2 className="text-xl font-bold text-neutral-950">Could not load tax transactions</h2>
      <p className="mt-2 text-neutral-600">{errorMessage(error)}</p>
    </div>
  );
}

export function TaxEmptyState() {
  return (
    <div className="rounded-3xl border border-neutral-200 bg-white p-8 text-center shadow-sm">
      <h2 className="text-2xl font-black text-neutral-950">No tax transactions synced</h2>
      <p className="mt-2 text-neutral-500">
        Use manual blockchain sync to import wallet activity for labeling.
      </p>
    </div>
  );
}

function AddressLine({ label, value }: { label: string; value: string | null }) {
  return (
    <p className="min-w-0 truncate">
      <span className="mr-2 font-sans text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-500 uppercase">
        {label}
      </span>
      <span title={value ?? undefined}>{value ? shortHash(value) : "n/a"}</span>
    </p>
  );
}

export function TransactionHashLink({ hash }: { hash: string }) {
  if (!hash.startsWith("0x")) {
    return (
      <span className="block truncate text-neutral-400" title={hash}>
        {shortHash(hash)}
      </span>
    );
  }
  return (
    <a
      className="block truncate transition hover:text-blue-700 hover:underline"
      href={transactionExplorerUrl(hash)}
      rel="noreferrer"
      target="_blank"
      title={hash}
    >
      {shortHash(hash)}
    </a>
  );
}

function transactionExplorerUrl(hash: string): string {
  return `https://www.hyperscan.com/tx/${encodeURIComponent(hash)}`;
}

function shortHash(value: string): string {
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function formatTimestamp(value: string | null): string {
  if (!value) return "Time n/a";

  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric * 1000) : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatTransactionValue(transaction: TaxTransaction): string {
  const symbol = transaction.token_symbol ?? "native";
  if (!transaction.value) return `0 ${symbol}`;

  const decimals = transaction.token_decimal ?? (transaction.token_symbol === null ? 18 : null);
  if (typeof decimals !== "number") {
    return `${transaction.value} ${symbol}`;
  }

  try {
    const value = BigInt(transaction.value);
    const divisor = 10n ** BigInt(decimals);
    const whole = value / divisor;
    const remainder = value % divisor;
    const decimal = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${whole.toString()}${decimal ? `.${decimal.slice(0, 6)}` : ""} ${symbol}`;
  } catch {
    return `${transaction.value} ${symbol}`;
  }
}

export function formatFee(fee: string | null): string | null {
  if (!fee) return null;
  return `${formatBaseUnitAmount(fee, 18)} HYPE`;
}

function formatBaseUnitAmount(value: string, decimals: number): string {
  try {
    const parsed = BigInt(value);
    const divisor = 10n ** BigInt(decimals);
    const whole = parsed / divisor;
    const remainder = parsed % divisor;
    const decimal = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${whole.toString()}${decimal ? `.${decimal}` : ""}`;
  } catch {
    return value;
  }
}

export function formatGroupFee(group: TaxTransactionGroup): string {
  return formatTaxLedgerValue(formatFee(group.primary.fee));
}

export function formatTaxLedgerValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

export type TaxLedgerField =
  | "incoming_quantity"
  | "incoming_asset"
  | "outgoing_quantity"
  | "outgoing_asset"
  | "cost_eur"
  | "proceeds_eur"
  | "gain_eur"
  | "holding_duration_days";

export function mixedTaxField(group: TaxTransactionGroup, field: TaxLedgerField): string {
  const values = new Set(group.transactions.map((transaction) => transaction[field] ?? ""));
  return values.size === 1 ? formatTaxLedgerValue([...values][0]) : "Mixed";
}

function formatGroupValueSummary(group: TaxTransactionGroup): string {
  const native = group.transactions.find((transaction) => transaction.token_symbol === null);
  const whype = group.transactions.find((transaction) => transaction.token_symbol === "WHYPE");

  if (native && whype) {
    const nativeValue = transactionValueBigInt(native);
    const whypeValue = transactionValueBigInt(whype);
    if (nativeValue === 0n && whypeValue !== null && whypeValue > 0n) {
      const nativeAmount = formatTokenAmount(whype.value, 18, "native");
      if (isWhypeUnwrap(native)) return `${formatTransactionValue(whype)} -> ${nativeAmount}`;
      if (isWhypeWrap(native)) return `${nativeAmount} -> ${formatTransactionValue(whype)}`;
    }
  }

  return group.transactions.map(formatTransactionValue).join(" -> ");
}

function transactionValueBigInt(transaction: TaxTransaction): bigint | null {
  if (!transaction.value) return 0n;
  try {
    return BigInt(transaction.value);
  } catch {
    return null;
  }
}

function isWhypeUnwrap(transaction: TaxTransaction): boolean {
  const text = `${transaction.function_name ?? ""} ${transaction.method_id ?? ""}`.toLowerCase();
  return text.includes("withdraw") || text.includes("unwrap");
}

function isWhypeWrap(transaction: TaxTransaction): boolean {
  const text = `${transaction.function_name ?? ""} ${transaction.method_id ?? ""}`.toLowerCase();
  return text.includes("deposit") || text.includes("wrap");
}

function formatTokenAmount(value: string | null, decimals: number, symbol: string): string {
  if (!value) return `0 ${symbol}`;

  try {
    const parsed = BigInt(value);
    const divisor = 10n ** BigInt(decimals);
    const whole = parsed / divisor;
    const remainder = parsed % divisor;
    const decimal = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${whole.toString()}${decimal ? `.${decimal.slice(0, 6)}` : ""} ${symbol}`;
  } catch {
    return `${value} ${symbol}`;
  }
}

function groupLabel(group: TaxTransactionGroup): string {
  const labels = new Set(group.transactions.map((transaction) => transaction.label ?? "Unlabeled"));
  return labels.size === 1 ? [...labels][0] : "Mixed labels";
}

export function groupControlTarget(group: TaxTransactionGroup): TaxTransactionControlTarget {
  return {
    id: group.id,
    hash: group.hash,
    label: groupControlLabel(group),
    comment: groupControlComment(group),
  };
}

function groupControlLabel(group: TaxTransactionGroup): TaxTransactionLabel | "mixed" {
  const labels = new Set(group.transactions.map((transaction) => transaction.label));
  return labels.size === 1 ? [...labels][0] : "mixed";
}

function groupControlComment(group: TaxTransactionGroup): string | null {
  const comments = new Set(group.transactions.map((transaction) => transaction.comment ?? ""));
  if (comments.size !== 1) return "";
  return [...comments][0] || null;
}

export function hasMixedGroupComments(group: TaxTransactionGroup): boolean {
  return new Set(group.transactions.map((transaction) => transaction.comment ?? "")).size > 1;
}

function functionLabel(transaction: TaxTransaction): string {
  return (
    transaction.function_name ??
    transaction.method_id ??
    transaction.transaction_type ??
    "Unknown function"
  );
}

function formatSyncCount(summary: Record<string, unknown>): string {
  const count = summary.insertedOrUpdated ?? summary.synced;
  return typeof count === "number" ? ` (${count} transactions)` : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
