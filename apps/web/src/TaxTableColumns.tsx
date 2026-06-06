import { createColumnHelper, type SortingFn } from "@tanstack/react-table";

import type { TaxTransactionUpdate } from "./api";
import {
  CommentEditor,
  LabelSelect,
  ManualTransactionEditor,
  TransactionHashLink,
  formatFee,
  formatGroupFee,
  formatTaxLedgerValue,
  formatTimestamp,
  groupControlTarget,
  hasMixedGroupComments,
  isManualTaxTransaction,
  mixedTaxField,
  type TaxTableRow,
  type TaxTransactionGroup,
  updateTaxTransactionGroup,
} from "./TaxTransactions";

export interface TableMeta {
  updateTransaction: (id: string, update: TaxTransactionUpdate) => void;
  isUpdating?: boolean;
}

// Custom numeric sort for string-encoded numbers (e.g. "100.00" > "9.00")
const numericStringSortingFn: SortingFn<TaxTableRow> = (rowA, rowB, columnId) => {
  const a = parseFloat(String(rowA.getValue(columnId) ?? "0")) || 0;
  const b = parseFloat(String(rowB.getValue(columnId) ?? "0")) || 0;
  return a - b;
};

// Sort for time_stamp — handles both ISO 8601 strings ("2026-05-30T12:00:00.000Z")
// and legacy Unix epoch-second strings ("1760000000").
const timestampSortingFn: SortingFn<TaxTableRow> = (rowA, rowB, columnId) => {
  const parse = (v: unknown): number => {
    if (v == null || v === "") return Number.NEGATIVE_INFINITY;
    const s = String(v);
    const n = Number(s);
    const ms = Number.isFinite(n) ? n * 1000 : new Date(s).getTime();
    return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
  };
  return parse(rowA.getValue(columnId)) - parse(rowB.getValue(columnId));
};

const columnHelper = createColumnHelper<TaxTableRow>();

export const taxTableColumns = [
  // Column 1: hash — 11%, not sortable
  columnHelper.display({
    id: "hash",
    header: "Hash",
    size: 11,
    enableSorting: false,
    cell: ({ row }) => {
      const groupData: TaxTransactionGroup | undefined = row.original._groupData;

      if (groupData) {
        const hash = row.original.hash;
        const isExpanded = row.getIsExpanded();
        return (
          <div>
            <TransactionHashLink hash={hash} />
            <span className="mt-1 block font-sans text-[0.68rem] font-semibold text-neutral-500 uppercase">
              grouped trade
            </span>
            <span className="mt-1 block font-sans text-[0.68rem] font-semibold text-neutral-500">
              {groupData.transactions.length} transaction parts
            </span>
            <button
              aria-expanded={isExpanded}
              aria-label={`${isExpanded ? "Hide" : "Show"} transaction parts for ${hash}`}
              className="mt-3 rounded-full border border-neutral-300 bg-white px-4 py-2 text-xs font-bold text-neutral-700 transition hover:border-neutral-950 hover:text-neutral-950"
              type="button"
              onClick={row.getToggleExpandedHandler()}
            >
              {isExpanded ? "Hide parts" : "Show parts"}
            </button>
          </div>
        );
      }

      return (
        <div className="relative">
          <div className={row.depth > 0 ? "translate-x-7" : undefined}>
            <TransactionHashLink hash={row.original.hash} />
            <span className="mt-1 block font-sans text-[0.68rem] font-semibold text-neutral-500 uppercase">
              {row.original.transaction_type ?? row.original.source}
            </span>
          </div>
        </div>
      );
    },
  }),

  // Column 2: time_stamp — 10%, sortable
  columnHelper.accessor((row) => row.time_stamp, {
    id: "time_stamp",
    header: "Time / Block",
    size: 10,
    enableSorting: true,
    sortingFn: timestampSortingFn,
    cell: ({ row }) => (
      <div className="font-mono text-xs text-neutral-600">
        <p className="font-bold text-neutral-950">{formatTimestamp(row.original.time_stamp)}</p>
        <p className="mt-1">Block {row.original.block_number ?? "n/a"}</p>
      </div>
    ),
  }),

  // Column 3: label — 9%, sortable
  columnHelper.accessor((row) => row.label, {
    id: "label",
    header: "Label",
    size: 9,
    enableSorting: true,
    cell: ({ row, table }) => {
      const meta = table.options.meta as TableMeta;
      const groupData: TaxTransactionGroup | undefined = row.original._groupData;

      if (groupData) {
        return (
          <>
            <LabelSelect
              transaction={groupControlTarget(groupData)}
              updateTransaction={(_id, update) =>
                updateTaxTransactionGroup(groupData, update, meta.updateTransaction)
              }
              disabled={meta.isUpdating}
            />
            <p className="mt-2 text-xs font-semibold text-neutral-500">Applies to all parts</p>
          </>
        );
      }

      if (isManualTaxTransaction(row.original)) {
        return (
          <ManualTransactionEditor
            transaction={row.original}
            updateTransaction={meta.updateTransaction}
            disabled={meta.isUpdating}
          />
        );
      }

      return (
        <LabelSelect
          transaction={row.original}
          updateTransaction={meta.updateTransaction}
          disabled={meta.isUpdating}
        />
      );
    },
  }),

  // Column 4: incoming_quantity — 7%, not sortable
  columnHelper.accessor((row) => row.incoming_quantity, {
    id: "incoming_quantity",
    header: "Incoming Qty",
    size: 7,
    enableSorting: false,
    cell: ({ row, getValue }) => {
      const groupData: TaxTransactionGroup | undefined = row.original._groupData;
      const content = groupData
        ? mixedTaxField(groupData, "incoming_quantity")
        : formatTaxLedgerValue(getValue());
      return <div className="truncate font-mono text-xs text-neutral-600">{content}</div>;
    },
  }),

  // Column 5: incoming_asset — 7%, not sortable
  columnHelper.accessor((row) => row.incoming_asset, {
    id: "incoming_asset",
    header: "Incoming Asset",
    size: 7,
    enableSorting: false,
    cell: ({ row, getValue }) => {
      const groupData: TaxTransactionGroup | undefined = row.original._groupData;
      const content = groupData
        ? mixedTaxField(groupData, "incoming_asset")
        : formatTaxLedgerValue(getValue());
      return <div className="truncate font-mono text-xs text-neutral-600">{content}</div>;
    },
  }),

  // Column 6: outgoing_quantity — 7%, not sortable
  columnHelper.accessor((row) => row.outgoing_quantity, {
    id: "outgoing_quantity",
    header: "Outgoing Qty",
    size: 7,
    enableSorting: false,
    cell: ({ row, getValue }) => {
      const groupData: TaxTransactionGroup | undefined = row.original._groupData;
      const content = groupData
        ? mixedTaxField(groupData, "outgoing_quantity")
        : formatTaxLedgerValue(getValue());
      return <div className="truncate font-mono text-xs text-neutral-600">{content}</div>;
    },
  }),

  // Column 7: outgoing_asset — 7%, not sortable
  columnHelper.accessor((row) => row.outgoing_asset, {
    id: "outgoing_asset",
    header: "Outgoing Asset",
    size: 7,
    enableSorting: false,
    cell: ({ row, getValue }) => {
      const groupData: TaxTransactionGroup | undefined = row.original._groupData;
      const content = groupData
        ? mixedTaxField(groupData, "outgoing_asset")
        : formatTaxLedgerValue(getValue());
      return <div className="truncate font-mono text-xs text-neutral-600">{content}</div>;
    },
  }),

  // Column 8: fee — 8%, sortable (numeric string)
  columnHelper.accessor((row) => row.fee, {
    id: "fee",
    header: "Fee",
    size: 8,
    enableSorting: true,
    sortingFn: numericStringSortingFn,
    cell: ({ row, getValue }) => {
      const groupData: TaxTransactionGroup | undefined = row.original._groupData;
      let content: string;
      if (groupData) {
        content = formatGroupFee(groupData);
      } else if (row.depth > 0) {
        content = formatTaxLedgerValue(null);
      } else {
        content = formatTaxLedgerValue(formatFee(getValue() ?? null));
      }
      return <div className="truncate font-mono text-xs text-neutral-600">{content}</div>;
    },
  }),

  // Column 9: cost_eur — 7%, sortable
  columnHelper.accessor((row) => row.cost_eur, {
    id: "cost_eur",
    header: "Cost EUR",
    size: 7,
    enableSorting: true,
    sortingFn: numericStringSortingFn,
    cell: ({ row, getValue }) => {
      const groupData: TaxTransactionGroup | undefined = row.original._groupData;
      const content = groupData
        ? mixedTaxField(groupData, "cost_eur")
        : formatTaxLedgerValue(getValue());
      return <div className="truncate font-mono text-xs text-neutral-600">{content}</div>;
    },
  }),

  // Column 10: proceeds_eur — 7%, sortable
  columnHelper.accessor((row) => row.proceeds_eur, {
    id: "proceeds_eur",
    header: "Proceeds EUR",
    size: 7,
    enableSorting: true,
    sortingFn: numericStringSortingFn,
    cell: ({ row, getValue }) => {
      const groupData: TaxTransactionGroup | undefined = row.original._groupData;
      const content = groupData
        ? mixedTaxField(groupData, "proceeds_eur")
        : formatTaxLedgerValue(getValue());
      return <div className="truncate font-mono text-xs text-neutral-600">{content}</div>;
    },
  }),

  // Column 11: gain_eur — 6%, sortable
  columnHelper.accessor((row) => row.gain_eur, {
    id: "gain_eur",
    header: "Gain EUR",
    size: 6,
    enableSorting: true,
    sortingFn: numericStringSortingFn,
    cell: ({ row, getValue }) => {
      const groupData: TaxTransactionGroup | undefined = row.original._groupData;
      const content = groupData
        ? mixedTaxField(groupData, "gain_eur")
        : formatTaxLedgerValue(getValue());
      return <div className="truncate font-mono text-xs text-neutral-600">{content}</div>;
    },
  }),

  // Column 12: holding_duration_days — 6%, sortable (numeric, value is number | null)
  columnHelper.accessor((row) => row.holding_duration_days, {
    id: "holding_duration_days",
    header: "Holding Days",
    size: 6,
    enableSorting: true,
    sortingFn: numericStringSortingFn,
    cell: ({ row, getValue }) => {
      const groupData: TaxTransactionGroup | undefined = row.original._groupData;
      const content = groupData
        ? mixedTaxField(groupData, "holding_duration_days")
        : formatTaxLedgerValue(getValue());
      return <div className="truncate font-mono text-xs text-neutral-600">{content}</div>;
    },
  }),

  // Column 13: comment/note — 8%, not sortable
  columnHelper.display({
    id: "comment",
    header: "Note",
    size: 8,
    enableSorting: false,
    cell: ({ row, table }) => {
      const meta = table.options.meta as TableMeta;
      const groupData: TaxTransactionGroup | undefined = row.original._groupData;

      if (groupData) {
        return (
          <CommentEditor
            transaction={groupControlTarget(groupData)}
            updateTransaction={(_id, update) =>
              updateTaxTransactionGroup(groupData, update, meta.updateTransaction)
            }
            disabled={meta.isUpdating}
            mixedComment={hasMixedGroupComments(groupData)}
          />
        );
      }

      return (
        <CommentEditor
          transaction={row.original}
          updateTransaction={meta.updateTransaction}
          disabled={meta.isUpdating}
        />
      );
    },
  }),
];
