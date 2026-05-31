import { useEffect, useState } from "react";

import type { TaxTransaction, TaxTransactionLabel, TaxTransactionUpdate } from "./api";
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

export interface TaxTransactionGroup {
  id: string;
  hash: string;
  primary: TaxTransaction;
  transactions: TaxTransaction[];
}

type UpdateTaxTransaction = (id: string, update: TaxTransactionUpdate) => void;

type TaxTransactionControlTarget = Pick<TaxTransaction, "id" | "hash" | "comment"> & {
  label: TaxTransactionLabel | "mixed";
};

export function groupTaxTransactions(transactions: TaxTransaction[]): TaxTransactionGroup[] {
  const groups = new Map<string, TaxTransactionGroup>();

  for (const transaction of transactions) {
    const existing = groups.get(transaction.hash);
    if (existing) {
      existing.transactions.push(transaction);
      continue;
    }

    groups.set(transaction.hash, {
      id: `hash:${transaction.hash}`,
      hash: transaction.hash,
      primary: transaction,
      transactions: [transaction],
    });
  }

  return [...groups.values()];
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
  defaultExpandedGroups = [],
}: {
  transactions: TaxTransaction[];
  updateTransaction: UpdateTaxTransaction;
  updateError?: unknown;
  isUpdating?: boolean;
  defaultExpandedGroups?: string[];
}) {
  const groups = groupTaxTransactions(transactions);
  const [expandedGroups, setExpandedGroups] = useState(() => new Set(defaultExpandedGroups));

  if (transactions.length === 0) {
    return <TaxEmptyState />;
  }

  function toggleGroup(groupId: string) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  return (
    <section className="overflow-x-clip rounded-3xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-5 py-4">
        <div>
          <p className="text-[0.65rem] font-semibold tracking-[0.28em] text-neutral-500 uppercase">
            Tax Blotter
          </p>
          <h2 className="mt-1 text-lg font-bold text-neutral-950">Synced Transactions</h2>
        </div>
        <span className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-xs font-semibold text-neutral-600">
          {groups.length} {groups.length === 1 ? "transaction" : "transactions"}
        </span>
      </div>
      {updateError ? (
        <div className="border-b border-neutral-200 bg-neutral-50 px-5 py-3 text-sm font-semibold text-neutral-700">
          Could not save transaction metadata: {errorMessage(updateError)}
        </div>
      ) : null}
      <div className="hidden lg:block">
        <table className="w-full table-fixed divide-y divide-neutral-200 text-sm">
          <colgroup>
            <col className="w-[11%]" />
            <col className="w-[10%]" />
            <col className="w-[9%]" />
            <col className="w-[7%]" />
            <col className="w-[7%]" />
            <col className="w-[7%]" />
            <col className="w-[7%]" />
            <col className="w-[8%]" />
            <col className="w-[7%]" />
            <col className="w-[7%]" />
            <col className="w-[6%]" />
            <col className="w-[6%]" />
            <col className="w-[8%]" />
          </colgroup>
          <thead className="text-left text-[0.68rem] tracking-[0.18em] text-neutral-500 uppercase">
            <tr>
              <th className="sticky top-0 z-10 bg-neutral-50 px-2 py-3 shadow-sm">Hash</th>
              <th className="sticky top-0 z-10 bg-neutral-50 px-2 py-3 shadow-sm">Time / Block</th>
              <th className="sticky top-0 z-10 bg-neutral-50 px-2 py-3 shadow-sm">Label</th>
              <th className="sticky top-0 z-10 bg-neutral-50 px-2 py-3 shadow-sm">Incoming Qty</th>
              <th className="sticky top-0 z-10 bg-neutral-50 px-2 py-3 shadow-sm">Incoming Asset</th>
              <th className="sticky top-0 z-10 bg-neutral-50 px-2 py-3 shadow-sm">Outgoing Qty</th>
              <th className="sticky top-0 z-10 bg-neutral-50 px-2 py-3 shadow-sm">Outgoing Asset</th>
              <th className="sticky top-0 z-10 bg-neutral-50 px-2 py-3 shadow-sm">Fee</th>
              <th className="sticky top-0 z-10 bg-neutral-50 px-2 py-3 shadow-sm">Cost EUR</th>
              <th className="sticky top-0 z-10 bg-neutral-50 px-2 py-3 shadow-sm">Proceeds EUR</th>
              <th className="sticky top-0 z-10 bg-neutral-50 px-2 py-3 shadow-sm">Gain EUR</th>
              <th className="sticky top-0 z-10 bg-neutral-50 px-2 py-3 shadow-sm">Holding Days</th>
              <th className="sticky top-0 z-10 bg-neutral-50 px-2 py-3 shadow-sm">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200">
            {groups.map((group) => {
              if (group.transactions.length === 1) {
                return (
                  <TaxTransactionRow
                    key={group.primary.id}
                    transaction={group.primary}
                    updateTransaction={updateTransaction}
                    isUpdating={isUpdating}
                  />
                );
              }

              const isExpanded = expandedGroups.has(group.id);
              return (
                <TaxTransactionGroupRows
                  key={group.id}
                  group={group}
                  isExpanded={isExpanded}
                  isUpdating={isUpdating}
                  updateTransaction={updateTransaction}
                  toggleGroup={() => toggleGroup(group.id)}
                />
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

          const isExpanded = expandedGroups.has(group.id);
          return (
            <TaxTransactionGroupCard
              key={group.id}
              group={group}
              isExpanded={isExpanded}
              isUpdating={isUpdating}
              updateTransaction={updateTransaction}
              toggleGroup={() => toggleGroup(group.id)}
            />
          );
        })}
      </div>
    </section>
  );
}

function TaxTransactionGroupRows({
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
    <>
      <tr className="align-top text-neutral-700 transition hover:bg-neutral-50">
        <td className="px-2 py-4 font-mono text-xs font-bold text-neutral-950">
          <TransactionHashLink hash={group.hash} />
          <span className="mt-1 block font-sans text-[0.68rem] font-semibold text-neutral-500 uppercase">
            grouped trade
          </span>
        </td>
        <td className="px-2 py-4 font-mono text-xs text-neutral-600">
          <p className="font-bold text-neutral-950">{formatTimestamp(group.primary.time_stamp)}</p>
          <p className="mt-1">Block {group.primary.block_number ?? "n/a"}</p>
        </td>
        <td className="px-2 py-4">
          <LabelSelect
            transaction={parentControlTarget}
            updateTransaction={(_id, update) => updateGroup(update)}
            disabled={isUpdating}
          />
          <p className="mt-2 text-xs font-semibold text-neutral-500">Applies to all parts</p>
        </td>
        <td className="truncate px-2 py-4 font-mono text-xs text-neutral-600">
          {mixedTaxField(group, "incoming_quantity")}
        </td>
        <td className="truncate px-2 py-4 font-mono text-xs text-neutral-600">
          {mixedTaxField(group, "incoming_asset")}
        </td>
        <td className="truncate px-2 py-4 font-mono text-xs text-neutral-600">
          {mixedTaxField(group, "outgoing_quantity")}
        </td>
        <td className="truncate px-2 py-4 font-mono text-xs text-neutral-600">
          {mixedTaxField(group, "outgoing_asset")}
        </td>
        <td className="truncate px-2 py-4 font-mono text-xs text-neutral-600">
          {formatGroupFee(group)}
        </td>
        <td className="truncate px-2 py-4 font-mono text-xs text-neutral-600">
          {mixedTaxField(group, "cost_eur")}
        </td>
        <td className="truncate px-2 py-4 font-mono text-xs text-neutral-600">
          {mixedTaxField(group, "proceeds_eur")}
        </td>
        <td className="truncate px-2 py-4 font-mono text-xs text-neutral-600">
          {mixedTaxField(group, "gain_eur")}
        </td>
        <td className="truncate px-2 py-4 font-mono text-xs text-neutral-600">
          {mixedTaxField(group, "holding_duration_days")}
        </td>
        <td className="px-2 py-4">
          <CommentEditor
            transaction={parentControlTarget}
            updateTransaction={(_id, update) => updateGroup(update)}
            disabled={isUpdating}
            mixedComment={hasMixedGroupComments(group)}
          />
        </td>
      </tr>
      <tr className="bg-neutral-50/70 text-neutral-600">
        <td className="px-2 py-3" colSpan={13}>
          <p className="font-semibold text-neutral-950">{group.transactions.length} transaction parts</p>
          <p className="font-mono text-sm font-bold text-neutral-950">{formatGroupValueSummary(group)}</p>
          <p className="mt-1 text-xs font-semibold text-neutral-500">Same transaction hash</p>
          <button
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? "Hide" : "Show"} transaction parts for ${group.hash}`}
            className="mt-3 rounded-full border border-neutral-300 bg-white px-4 py-2 text-xs font-bold text-neutral-700 transition hover:border-neutral-950 hover:text-neutral-950"
            type="button"
            onClick={toggleGroup}
          >
            {isExpanded ? "Hide parts" : "Show parts"}
          </button>
        </td>
      </tr>
      {isExpanded
        ? group.transactions.map((transaction, index) => (
            <TaxTransactionRow
              key={transaction.id}
              transaction={transaction}
              updateTransaction={updateTransaction}
              isUpdating={isUpdating}
              isGroupedChild
              isLastGroupedChild={index === group.transactions.length - 1}
            />
          ))
        : null}
    </>
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
            {formatTimestamp(group.primary.time_stamp)} / Block {group.primary.block_number ?? "n/a"}
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
        <p className="mt-1 font-mono font-bold text-neutral-950">{formatGroupValueSummary(group)}</p>
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

function TaxTransactionRow({
  transaction,
  updateTransaction,
  isUpdating,
  isGroupedChild = false,
  isLastGroupedChild = false,
}: {
  transaction: TaxTransaction;
  updateTransaction: UpdateTaxTransaction;
  isUpdating?: boolean;
  isGroupedChild?: boolean;
  isLastGroupedChild?: boolean;
}) {
  const groupedChildConnectorClass = isLastGroupedChild
    ? "before:absolute before:top-0 before:left-5 before:h-7 before:w-px before:bg-neutral-300 after:absolute after:top-7 after:left-5 after:h-px after:w-4 after:bg-neutral-300"
    : "before:absolute before:top-0 before:bottom-0 before:left-5 before:w-px before:bg-neutral-300 after:absolute after:top-7 after:left-5 after:h-px after:w-4 after:bg-neutral-300";

  return (
    <tr
      className={`align-top text-neutral-700 transition hover:bg-neutral-50 ${isGroupedChild ? "bg-neutral-50/60" : ""}`}
    >
      <td
        className={`relative py-4 pr-2 pl-2 font-mono text-xs font-bold text-neutral-950 ${isGroupedChild ? groupedChildConnectorClass : ""}`}
      >
        <div className={isGroupedChild ? "translate-x-7" : undefined}>
          <TransactionHashLink hash={transaction.hash} />
          <span className="mt-1 block font-sans text-[0.68rem] font-semibold text-neutral-500 uppercase">
            {transaction.transaction_type ?? transaction.source}
          </span>
        </div>
      </td>
      <td className="px-2 py-4 font-mono text-xs text-neutral-600">
        <p className="font-bold text-neutral-950">{formatTimestamp(transaction.time_stamp)}</p>
        <p className="mt-1">Block {transaction.block_number ?? "n/a"}</p>
      </td>
      <td className="px-2 py-4">
        <LabelSelect
          transaction={transaction}
          updateTransaction={updateTransaction}
          disabled={isUpdating}
        />
      </td>
      <TaxValueCell value={transaction.incoming_quantity} />
      <TaxValueCell value={transaction.incoming_asset} />
      <TaxValueCell value={transaction.outgoing_quantity} />
      <TaxValueCell value={transaction.outgoing_asset} />
      <TaxValueCell value={isGroupedChild ? null : formatFee(transaction.fee)} />
      <TaxValueCell value={transaction.cost_eur} />
      <TaxValueCell value={transaction.proceeds_eur} />
      <TaxValueCell value={transaction.gain_eur} />
      <TaxValueCell value={transaction.holding_duration_days} />
      <td className="px-2 py-4">
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
        const value = event.currentTarget.value as "" | NonNullable<TaxTransactionLabel>;
        updateTransaction(transaction.id, { label: value === "" ? null : value });
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

function CommentEditor({
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

function TaxValueCell({ value }: { value: string | number | null | undefined }) {
  return (
    <td className="truncate px-2 py-4 font-mono text-xs text-neutral-600" title={formatTaxLedgerValue(value)}>
      {formatTaxLedgerValue(value)}
    </td>
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

function formatFee(fee: string | null): string | null {
  if (!fee) return null;
  return `${formatBaseUnitAmount(fee, 18)} HYPE`;
}

function formatBaseUnitAmount(value: string, decimals: number): string {
  try {
    const parsed = BigInt(value);
    const divisor = 10n ** BigInt(decimals);
    const whole = parsed / divisor;
    const remainder = parsed % divisor;
    const decimal = remainder
      .toString()
      .padStart(decimals, "0")
      .replace(/0+$/, "");
    return `${whole.toString()}${decimal ? `.${decimal}` : ""}`;
  } catch {
    return value;
  }
}

function formatGroupFee(group: TaxTransactionGroup): string {
  return formatTaxLedgerValue(formatFee(group.primary.fee));
}

function formatTaxLedgerValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

type TaxLedgerField =
  | "incoming_quantity"
  | "incoming_asset"
  | "outgoing_quantity"
  | "outgoing_asset"
  | "cost_eur"
  | "proceeds_eur"
  | "gain_eur"
  | "holding_duration_days";

function mixedTaxField(group: TaxTransactionGroup, field: TaxLedgerField): string {
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
    const decimal = remainder
      .toString()
      .padStart(decimals, "0")
      .replace(/0+$/, "");
    return `${whole.toString()}${decimal ? `.${decimal.slice(0, 6)}` : ""} ${symbol}`;
  } catch {
    return `${value} ${symbol}`;
  }
}

function groupLabel(group: TaxTransactionGroup): string {
  const labels = new Set(group.transactions.map((transaction) => transaction.label ?? "Unlabeled"));
  return labels.size === 1 ? [...labels][0] : "Mixed labels";
}

function groupControlTarget(group: TaxTransactionGroup): TaxTransactionControlTarget {
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

function hasMixedGroupComments(group: TaxTransactionGroup): boolean {
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
