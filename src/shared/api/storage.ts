// Storage and limits: the caller's receipt usage against the fair-use quota,
// their counts against the other per-account limits, the receipts they
// uploaded, and permanent receipt deletion (src/server/storage.ts).
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { Id, ReadError, WriteError } from './core'

/** A receipt deleted for good: readers show who deleted it and when, instead of the image. */
export const ReceiptTombstone = Schema.Struct({ by: Schema.String, at: Schema.String })

export const StorageUsage = Schema.Struct({
  receipts: Schema.Struct({
    usedBytes: Schema.Number,
    limitBytes: Schema.Number,
    count: Schema.Number,
    /** Bytes in groups the caller has left; an admin of that group can delete them. */
    elsewhereBytes: Schema.Number,
  }),
  groups: Schema.Struct({ created: Schema.Number, limit: Schema.Number }),
  apiKeys: Schema.Struct({ count: Schema.Number, limit: Schema.Number }),
})

export const OwnReceipt = Schema.Struct({
  id: Schema.String,
  groupId: Schema.String,
  /** Null for an ungrouped expense's private context. */
  groupName: Schema.NullOr(Schema.String),
  /** The newest live expense that shows the receipt, else a deleted one; null when none does. */
  expense: Schema.NullOr(Schema.Struct({ id: Schema.String, title: Schema.String, deleted: Schema.Boolean })),
  bytes: Schema.Number,
  createdAt: Schema.String,
  downloadUrl: Schema.String,
})

export const ReceiptOrder = Schema.Literals(['largest', 'oldest'])

export class StorageApi extends RpcGroup.make(
  Rpc.make('storage.usage', { success: StorageUsage, error: ReadError }),
  Rpc.make('storage.receipts', {
    payload: {
      order: ReceiptOrder,
      cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
    },
    success: Schema.Struct({ receipts: Schema.Array(OwnReceipt), nextCursor: Schema.NullOr(Schema.Number) }),
    error: ReadError,
  }),
  Rpc.make('storage.deleteReceipts', {
    payload: { receiptIds: Schema.Array(Id).check(Schema.isBetweenLength(1, 100)) },
    success: Schema.Struct({
      deleted: Schema.Array(Schema.Struct({ receiptId: Schema.String, bytes: Schema.Number })),
      freedBytes: Schema.Number,
      usedBytes: Schema.Number,
    }),
    error: WriteError,
  }),
) {}
