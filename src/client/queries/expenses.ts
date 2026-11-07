// Queries and cache updates for the expenses area. Writes invalidate every
// screen that shows money, so the balance rail, the lists and the tabs agree.
import { infiniteQueryOptions, queryOptions, type QueryClient } from '@tanstack/react-query'
import { LIMITS } from '../../shared/limits'
import { rpc } from '../rpc'

/** Categories and currencies never change at run time; load them once per session. */
export const referenceQuery = queryOptions({
  queryKey: ['reference'],
  queryFn: () => rpc((api) => api('reference.get', undefined)),
  staleTime: Infinity,
})

export const expenseDetailQuery = (group: string, expenseId: string) =>
  queryOptions({
    queryKey: ['expense', group, expenseId],
    queryFn: () => rpc((api) => api('expenses.detail', { groupId: group, expenseId })),
  })

/** Balances and suggested settlements per currency. The tabs read them fresh each time they open (P-BAL-50). */
export const balancesQuery = (group: string) =>
  queryOptions({
    queryKey: ['balances', group],
    queryFn: () => rpc((api) => api('balances.list', { groupId: group })),
    staleTime: 0,
  })

/** Payment history, a page of expenses at a time (P-BAL-67). */
export const paymentsQuery = (group: string) =>
  infiniteQueryOptions({
    queryKey: ['expenses', group, { kind: 'payment' }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => rpc((api) => api('expenses.list', { groupId: group, filter: { kind: 'payment' }, cursor: pageParam, limit: LIMITS.expensePage })),
    getNextPageParam: (page) => page.nextCursor,
  })

/** After any expense write: drop every cached view of the group's money. */
export async function invalidateMoney(data: { queryClient: QueryClient; group: string }) {
  const { queryClient, group } = data
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['group', group] }),
    queryClient.invalidateQueries({ queryKey: ['expenses', group] }),
    queryClient.invalidateQueries({ queryKey: ['expense', group] }),
    queryClient.invalidateQueries({ queryKey: ['balances', group] }),
  ])
}
