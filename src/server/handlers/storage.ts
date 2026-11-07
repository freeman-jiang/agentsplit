// Storage and limits on the Settings screen: usage, the caller's receipts, and
// permanent deletion (src/server/storage.ts).
import { Effect, Layer } from 'effect'
import { Api, ReceiptBucket, read, write } from '../rpc'
import * as storage from '../storage'

export const StorageHandlers = Layer.mergeAll(
  Api.toLayerHandler('storage.usage', () => read((db, principal) => storage.storageUsage(db, { principal }))),
  Api.toLayerHandler('storage.receipts', ({ order, cursor, limit }) => read((db, principal) => storage.listReceipts(db, { principal, order, cursor, limit }))),
  Api.toLayerHandler('storage.deleteReceipts', ({ receiptIds }) =>
    Effect.flatMap(ReceiptBucket, (bucket) => write((db, principal, afterCommit) => storage.deleteOwnReceipts(db, { principal, receiptIds, bucket, afterCommit }))),
  ),
)
