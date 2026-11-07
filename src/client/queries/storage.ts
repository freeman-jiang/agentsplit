// Storage and limits on Settings: the caller's usage, and their receipts a page at a time.
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { rpc } from '../rpc'

export const storageUsageQuery = queryOptions({ queryKey: ['storage', 'usage'], queryFn: () => rpc((api) => api('storage.usage', undefined)) })

export type ReceiptOrder = 'largest' | 'oldest'
const PAGE = 20

export const ownReceiptsQuery = (order: ReceiptOrder) =>
  infiniteQueryOptions({
    queryKey: ['storage', 'receipts', order],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => rpc((api) => api('storage.receipts', { order, cursor: pageParam, limit: PAGE })),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
