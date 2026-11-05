import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { ExpenseFilter as Filter } from '../shared/api'

type ExpenseFilter = typeof Filter.Type
import { rpc } from './rpc'

export const meQuery = queryOptions({ queryKey: ['me'], queryFn: () => rpc((api) => api('session.me', undefined)) })

export const groupsQuery = queryOptions({ queryKey: ['groups'], queryFn: () => rpc((api) => api('groups.list', undefined)) })

export const groupQuery = (group: string) =>
  queryOptions({ queryKey: ['group', group], queryFn: () => rpc((api) => api('groups.get', { groupId: group })) })

export const expensesQuery = (group: string, filter: ExpenseFilter) =>
  infiniteQueryOptions({
    queryKey: ['expenses', group, filter],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => rpc((api) => api('expenses.list', { groupId: group, filter, cursor: pageParam, limit: 30 })),
    getNextPageParam: (page) => page.nextCursor,
  })
