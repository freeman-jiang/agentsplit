import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { ExpenseFilter } from '../../shared/api'
import { LIMITS } from '../../shared/limits'
import { rpc } from '../rpc'
import { keys } from './keys'

/** Categories and currencies never change at run time; load them once per session. */
export const referenceQuery = queryOptions({
  queryKey: keys.reference,
  queryFn: () => rpc((api) => api('reference.get', undefined)),
  staleTime: Infinity,
})

/** A group's expenses, a page at a time (P-EXP-07). */
export const expensesQuery = (groupId: string, filter: typeof ExpenseFilter.Type) =>
  infiniteQueryOptions({
    queryKey: keys.expenses(groupId, filter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => rpc((api) => api('expenses.list', { groupId, filter, cursor: pageParam, limit: LIMITS.expensePage })),
    getNextPageParam: (page) => page.nextCursor,
  })

/** Payment history (P-BAL-67). */
export const paymentsQuery = (groupId: string) => expensesQuery(groupId, { kind: 'payment' })

export const expenseDetailQuery = (groupId: string, expenseId: string) =>
  queryOptions({ queryKey: keys.expense(groupId, expenseId), queryFn: () => rpc((api) => api('expenses.detail', { groupId, expenseId })) })

/** Balances and suggested settlements per currency. The tabs read them fresh each time they open (P-BAL-50). */
export const balancesQuery = (groupId: string) =>
  queryOptions({ queryKey: keys.balances(groupId), queryFn: () => rpc((api) => api('balances.list', { groupId })) })
