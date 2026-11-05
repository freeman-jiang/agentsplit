import { infiniteQueryOptions, queryOptions, type QueryClient } from '@tanstack/react-query'
import type { FeedCursor, FeedFilter } from '../../shared/api'
import { rpc } from '../rpc'

type Filter = typeof FeedFilter.Type
type Cursor = typeof FeedCursor.Type

// The dashboard reads fresh on every visit: other people and agents change the ledger.
export const feedQuery = (filter: Filter) =>
  infiniteQueryOptions({
    queryKey: ['feed', 'list', filter],
    initialPageParam: null as Cursor | null,
    queryFn: ({ pageParam }) => rpc((api) => api('feed.list', { filter, cursor: pageParam, limit: 30 })),
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 0,
  })

export const accountBalancesQuery = queryOptions({
  queryKey: ['feed', 'balances'],
  queryFn: () => rpc((api) => api('feed.balances', undefined)),
  staleTime: 0,
})

export const feedOptionsQuery = queryOptions({ queryKey: ['feed', 'options'], queryFn: () => rpc((api) => api('feed.options', undefined)) })

export const expenseContextQuery = (expenseId: string) =>
  queryOptions({ queryKey: ['expense-context', expenseId], queryFn: () => rpc((api) => api('expenses.context', { expenseId })) })

/** After any expense write: every screen that shows expenses or balances reads again. */
export const invalidateExpenses = (client: QueryClient) =>
  Promise.all(['feed', 'expense-context', 'expenses', 'group'].map((key) => client.invalidateQueries({ queryKey: [key] })))

/** The message to show for a failed call: the server's text, or a plain fallback. */
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && '_tag' in error) {
    const e = error as { _tag: string; message?: unknown }
    if (e._tag === 'NotFound') return 'Expense not found.'
    if (e._tag === 'Conflict') return 'Someone changed this expense. Reload it, then try again.'
    if (e._tag === 'Unauthorized') return 'Sign in again to continue.'
    if (typeof e.message === 'string' && e.message) return e.message
  }
  return error instanceof Error ? error.message : 'Something went wrong. Try again.'
}
