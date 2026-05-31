import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createTaxTransaction,
  getTaxTransactions,
  syncTaxTransactions,
  updateTaxTransaction,
  type ManualTaxTransactionCreateInput,
  type TaxTransactionUpdate,
  type TaxTransactionsOptions,
} from "../api";

export const taxTransactionQueryKeys = {
  all: ["taxTransactions"] as const,
  list: (options: TaxTransactionsOptions = {}) =>
    [...taxTransactionQueryKeys.all, options] as const,
};

export function useTaxTransactions(options: TaxTransactionsOptions = {}) {
  return useQuery({
    queryKey: taxTransactionQueryKeys.list(options),
    queryFn: () => getTaxTransactions(options),
  });
}

export function useSyncTaxTransactions() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: syncTaxTransactions,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taxTransactionQueryKeys.all });
    },
  });
}

export function useCreateTaxTransaction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ManualTaxTransactionCreateInput) => createTaxTransaction(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taxTransactionQueryKeys.all });
    },
  });
}

export function useUpdateTaxTransaction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: TaxTransactionUpdate }) =>
      updateTaxTransaction(id, update),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taxTransactionQueryKeys.all });
    },
  });
}
