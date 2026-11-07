// Storage and limits on the Settings screen: usage, the caller's receipts, and
// permanent deletion. The objects leave storage after the deleting
// transaction commits; if that fails, the hourly job removes them.
import { Effect, Layer } from 'effect'
import { useDb } from '../db'
import { Api, AppConfig, ReceiptBucket, read, write } from '../rpc'
import * as storage from '../storage'

export const StorageHandlers = Layer.mergeAll(
  Api.toLayerHandler('storage.usage', () => read((db, principal) => storage.storageUsage(db, { principal }))),
  Api.toLayerHandler('storage.receipts', ({ order, cursor, limit }) =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      return yield* read((db, principal) => storage.listReceipts(db, { principal, order, cursor, limit, baseUrl: config.baseUrl }))
    }),
  ),
  Api.toLayerHandler('storage.deleteReceipts', ({ receiptIds }) =>
    Effect.gen(function* () {
      const bucket = yield* ReceiptBucket
      const result = yield* write((db, principal) => storage.deleteOwnReceipts(db, { principal, receiptIds }))
      yield* useDb((db) => storage.purgeDeletedReceipts({ db, bucket, receiptIds })).pipe(
        Effect.ignore({ log: 'Warn', message: 'Removing deleted receipts from storage failed; the hourly job retries' }),
      )
      return result
    }),
  ),
)
