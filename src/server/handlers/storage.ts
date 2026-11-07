// Storage and limits on the Settings screen: usage, the caller's receipts, and
// permanent deletion. The objects leave storage after the deleting
// transaction commits; if that fails, the hourly job removes them.
import { Effect, Layer } from 'effect'
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
    Effect.flatMap(ReceiptBucket, (bucket) =>
      write(async (db, principal, afterCommit) => {
        const result = await storage.deleteOwnReceipts(db, { principal, receiptIds })
        afterCommit((connection) => storage.purgeDeletedReceipts({ db: connection, bucket, receiptIds }))
        return result
      }),
    ),
  ),
)
