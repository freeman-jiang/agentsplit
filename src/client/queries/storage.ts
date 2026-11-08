// Storage and limits on Settings: the caller's usage, and their receipts a page at a time.
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { ReceiptOrder } from '../../shared/api'
import { LIMITS } from '../../shared/limits'
import { rpc } from '../rpc'
import { keys } from './keys'

export const storageUsageQuery = queryOptions({ queryKey: keys.storageUsage, queryFn: () => rpc((api) => api('storage.usage', undefined)) })

export const ownReceiptsQuery = (order: typeof ReceiptOrder.Type) =>
  infiniteQueryOptions({
    queryKey: keys.ownReceipts(order),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => rpc((api) => api('storage.receipts', { order, cursor: pageParam, limit: LIMITS.receiptPage })),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
