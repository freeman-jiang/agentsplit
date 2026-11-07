// The dashboard and the /expenses pages: reads across every group. Each visit
// reads them fresh, as the client's default does (main.tsx).
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { FeedCursor, FeedFilter } from '../../shared/api'
import { LIMITS } from '../../shared/limits'
import { rpc } from '../rpc'
import { keys } from './keys'

export const feedQuery = (filter: typeof FeedFilter.Type) =>
  infiniteQueryOptions({
    queryKey: keys.feedList(filter),
    initialPageParam: null as typeof FeedCursor.Type | null,
    queryFn: ({ pageParam }) => rpc((api) => api('feed.list', { filter, cursor: pageParam, limit: LIMITS.expensePage })),
    getNextPageParam: (page) => page.nextCursor,
  })

export const accountBalancesQuery = queryOptions({ queryKey: keys.feedBalances, queryFn: () => rpc((api) => api('feed.balances', undefined)) })

export const feedOptionsQuery = queryOptions({ queryKey: keys.feedOptions, queryFn: () => rpc((api) => api('feed.options', undefined)) })

export const expenseContextQuery = (expenseId: string) =>
  queryOptions({ queryKey: keys.expenseContext(expenseId), queryFn: () => rpc((api) => api('expenses.context', { expenseId })) })
