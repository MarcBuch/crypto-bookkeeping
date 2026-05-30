import { useEffect, useState } from "react";

import type { TaxTransaction, TaxTransactionLabel } from "./api";
import {
  useSyncTaxTransactions,
  useTaxTransactions,
  useUpdateTaxTransaction,
} from "./hooks/useTaxTransactions";

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

export function TaxTransactions() {
  const { data: transactions, error, isLoading, isFetching } = useTaxTransactions({ limit: 200 });
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
          <div className="grid gap-5 p-5 sm:p-7 lg:grid-cols-[1fr_auto] lg:items-end">
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
            <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
              <p className="text-[0.65rem] font-semibold tracking-[0.26em] text-neutral-500 uppercase">
                Blockchain Sync
              </p>
              <button
                className="mt-4 w-full rounded-full bg-neutral-950 px-5 py-3 text-sm font-bold text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
                disabled={syncMutation.isPending}
                type="button"
                onClick={() => syncMutation.mutate()}
              >
                {syncMutation.isPending ? "Syncing..." : "Sync blockchain data"}
              </button>
              <SyncStatus mutation={syncMutation} isFetching={isFetching && !isLoading} />
            </div>
          </div>
        </header>

        {isLoading ? <TaxLoadingState /> : null}
        {error ? <TaxErrorState error={error} /> : null}
        {!isLoading && !error && transactions ? (
          <TaxTransactionLedger
            transactions={transactions}
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
  updateTransaction,
  updateError,
  isUpdating,
}: {
  transactions: TaxTransaction[];
  updateTransaction: (
    id: string,
    update: { label?: TaxTransactionLabel; comment?: string | null },
  ) => void;
  updateError?: unknown;
  isUpdating?: boolean;
}) {
  if (transactions.length === 0) {
    return <TaxEmptyState />;
  }

  return (
    <section className="overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-5 py-4">
        <div>
          <p className="text-[0.65rem] font-semibold tracking-[0.28em] text-neutral-500 uppercase">
            Tax Blotter
          </p>
          <h2 className="mt-1 text-lg font-bold text-neutral-950">Synced Transactions</h2>
        </div>
        <span className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-xs font-semibold text-neutral-600">
          {transactions.length} transactions
        </span>
      </div>
      {updateError ? (
        <div className="border-b border-neutral-200 bg-neutral-50 px-5 py-3 text-sm font-semibold text-neutral-700">
          Could not save transaction metadata: {errorMessage(updateError)}
        </div>
      ) : null}
      <div className="hidden overflow-x-auto lg:block">
        <table className="min-w-full divide-y divide-neutral-200 text-sm">
          <thead className="bg-neutral-50 text-left text-[0.68rem] tracking-[0.18em] text-neutral-500 uppercase">
            <tr>
              <th className="px-5 py-3">Hash</th>
              <th className="px-5 py-3">Time / Block</th>
              <th className="px-5 py-3">From / To</th>
              <th className="px-5 py-3">Value / Function</th>
              <th className="px-5 py-3">Label</th>
              <th className="px-5 py-3">Comment</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200">
            {transactions.map((transaction) => (
              <TaxTransactionRow
                key={transaction.id}
                transaction={transaction}
                updateTransaction={updateTransaction}
                isUpdating={isUpdating}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="divide-y divide-neutral-200 lg:hidden">
        {transactions.map((transaction) => (
          <TaxTransactionCard
            key={transaction.id}
            transaction={transaction}
            updateTransaction={updateTransaction}
            isUpdating={isUpdating}
          />
        ))}
      </div>
    </section>
  );
}

function TaxTransactionRow({
  transaction,
  updateTransaction,
  isUpdating,
}: {
  transaction: TaxTransaction;
  updateTransaction: (
    id: string,
    update: { label?: TaxTransactionLabel; comment?: string | null },
  ) => void;
  isUpdating?: boolean;
}) {
  return (
    <tr className="align-top text-neutral-700 transition hover:bg-neutral-50">
      <td className="max-w-[180px] px-5 py-4 font-mono text-xs font-bold text-neutral-950">
        <TransactionHashLink hash={transaction.hash} />
        <span className="mt-1 block font-sans text-[0.68rem] font-semibold text-neutral-500 uppercase">
          {transaction.transaction_type ?? transaction.source}
        </span>
      </td>
      <td className="px-5 py-4 font-mono text-xs whitespace-nowrap text-neutral-600">
        <p className="font-bold text-neutral-950">{formatTimestamp(transaction.time_stamp)}</p>
        <p className="mt-1">Block {transaction.block_number ?? "n/a"}</p>
      </td>
      <td className="max-w-[220px] px-5 py-4 font-mono text-xs text-neutral-600">
        <AddressLine label="From" value={transaction.from_address} />
        <AddressLine label="To" value={transaction.to_address} />
      </td>
      <td className="max-w-[240px] px-5 py-4 text-neutral-700">
        <p className="font-mono text-sm font-bold text-neutral-950">
          {formatTransactionValue(transaction)}
        </p>
        <p
          className="mt-1 truncate text-xs font-semibold text-neutral-500"
          title={functionLabel(transaction)}
        >
          {functionLabel(transaction)}
        </p>
      </td>
      <td className="px-5 py-4">
        <LabelSelect
          transaction={transaction}
          updateTransaction={updateTransaction}
          disabled={isUpdating}
        />
      </td>
      <td className="min-w-[260px] px-5 py-4">
        <CommentEditor
          transaction={transaction}
          updateTransaction={updateTransaction}
          disabled={isUpdating}
        />
      </td>
    </tr>
  );
}

function TaxTransactionCard({
  transaction,
  updateTransaction,
  isUpdating,
}: {
  transaction: TaxTransaction;
  updateTransaction: (
    id: string,
    update: { label?: TaxTransactionLabel; comment?: string | null },
  ) => void;
  isUpdating?: boolean;
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
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-[180px_1fr]">
        <LabelSelect
          transaction={transaction}
          updateTransaction={updateTransaction}
          disabled={isUpdating}
        />
        <CommentEditor
          transaction={transaction}
          updateTransaction={updateTransaction}
          disabled={isUpdating}
        />
      </div>
    </article>
  );
}

function LabelSelect({
  transaction,
  updateTransaction,
  disabled,
}: {
  transaction: TaxTransaction;
  updateTransaction: (id: string, update: { label?: TaxTransactionLabel }) => void;
  disabled?: boolean;
}) {
  return (
    <select
      className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm font-semibold text-neutral-950 transition outline-none focus:border-neutral-950 disabled:bg-neutral-100 disabled:text-neutral-500"
      disabled={disabled}
      value={transaction.label ?? ""}
      onChange={(event) => {
        const value = event.currentTarget.value as "" | NonNullable<TaxTransactionLabel>;
        updateTransaction(transaction.id, { label: value === "" ? null : value });
      }}
    >
      {taxTransactionLabelOptions.map((option) => (
        <option key={option.label} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function CommentEditor({
  transaction,
  updateTransaction,
  disabled,
}: {
  transaction: TaxTransaction;
  updateTransaction: (id: string, update: { comment?: string | null }) => void;
  disabled?: boolean;
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
        disabled={disabled}
        placeholder="Add tax note"
        value={comment}
        onChange={(event) => setComment(event.currentTarget.value)}
      />
      <button
        className="justify-self-start rounded-full border border-neutral-300 bg-white px-4 py-2 text-xs font-bold text-neutral-700 transition hover:border-neutral-950 hover:text-neutral-950 disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-400"
        disabled={disabled || !commentDraft.isDirty}
        type="button"
        onClick={() => updateTransaction(transaction.id, { comment: commentDraft.update })}
      >
        Save comment
      </button>
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

  return (
    <p className="mt-3 text-xs font-semibold text-neutral-500">
      Press to fetch latest wallet activity.
    </p>
  );
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

function TransactionHashLink({ hash }: { hash: string }) {
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

function formatTimestamp(value: string | null): string {
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
    const decimal = remainder
      .toString()
      .padStart(decimals, "0")
      .replace(/0+$/, "");
    return `${whole.toString()}${decimal ? `.${decimal.slice(0, 6)}` : ""} ${symbol}`;
  } catch {
    return `${transaction.value} ${symbol}`;
  }
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
