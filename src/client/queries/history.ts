import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { CurrencyCode } from '../../shared/currencies'
import { LIMITS } from '../../shared/limits'
import { rpc } from '../rpc'
import { keys } from './keys'

/**
 * Group Log pages. Every page after the first reuses the first page's
 * boundary, so events recorded while the Log is open do not shift the pages.
 */
export const activitiesQuery = (groupId: string, filter: { expenseId?: string } = {}) =>
  infiniteQueryOptions({
    queryKey: keys.activities(groupId, filter),
    initialPageParam: { cursor: 0, atActivityId: null as string | null },
    queryFn: ({ pageParam }) =>
      rpc((api) =>
        api('history.activities', {
          groupId,
          cursor: pageParam.cursor,
          limit: LIMITS.logPage,
          ...filter,
          ...(pageParam.atActivityId ? { atActivityId: pageParam.atActivityId } : {}),
        }),
      ),
    getNextPageParam: (page) => (page.hasMore ? { cursor: page.nextCursor, atActivityId: page.atActivityId } : undefined),
  })

export type StatsScope = { currency?: CurrencyCode; from?: string; to?: string }

/** The whole Stats tab in one request; `today` is the browser's calendar day, for the month padding. */
export const statsQuery = (groupId: string, scope: StatsScope & { today: string }) =>
  queryOptions({ queryKey: keys.stats(groupId, scope), queryFn: () => rpc((api) => api('stats.overview', { groupId, ...scope })) })

export const statsExpensesQuery = (groupId: string, scope: StatsScope & { currency: CurrencyCode; month?: string; categoryId?: number }) =>
  queryOptions({ queryKey: keys.statsExpenses(groupId, scope), queryFn: () => rpc((api) => api('stats.expenses', { groupId, ...scope })) })
