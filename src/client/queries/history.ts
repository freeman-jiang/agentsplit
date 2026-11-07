import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { CurrencyCode } from '../../shared/currencies'
import { LIMITS } from '../../shared/limits'
import { rpc } from '../rpc'

/**
 * Group Log pages. Every page after the first reuses the first page's
 * boundary, so events recorded while the Log is open do not shift the pages.
 */
export const activitiesQuery = (group: string, filter: { expenseId?: string } = {}) =>
  infiniteQueryOptions({
    queryKey: ['activities', group, filter],
    initialPageParam: { cursor: 0, atActivityId: null as string | null },
    queryFn: ({ pageParam }) =>
      rpc((api) =>
        api('history.activities', {
          groupId: group,
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
export const statsQuery = (group: string, scope: StatsScope & { today: string }) =>
  queryOptions({ queryKey: ['stats', group, scope], queryFn: () => rpc((api) => api('stats.overview', { groupId: group, ...scope })) })

export const statsExpensesQuery = (group: string, scope: StatsScope & { currency: CurrencyCode; month?: string; categoryId?: number }) =>
  queryOptions({ queryKey: ['stats-expenses', group, scope], queryFn: () => rpc((api) => api('stats.expenses', { groupId: group, ...scope })) })
