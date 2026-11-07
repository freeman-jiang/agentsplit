// Storage tools: get_storage_usage, list_receipts and delete_receipts, from
// src/server/storage.ts, the same services as Settings, Storage and limits.
// Receipt storage is a fair-use quota per uploader (src/shared/limits.ts).
import { Schema } from 'effect'
import { FAIR_USE, LIMITS } from '../../../shared/limits'
import * as storage from '../../storage'
import { defineTool } from '../registry'
import { DateTime, Id, NoArguments, NonNegativeInt, NullableString, RecordedTime, ShortId } from './shared'

const Usage = Schema.Struct({
  receipts: Schema.Struct({
    usedBytes: NonNegativeInt,
    limitBytes: NonNegativeInt,
    count: NonNegativeInt,
    elsewhereBytes: NonNegativeInt.annotate({ description: 'Bytes in groups you have left. They count; an admin of that group can delete them.' }),
  }),
  groups: Schema.Struct({ created: NonNegativeInt, limit: NonNegativeInt }),
  apiKeys: Schema.Struct({ count: NonNegativeInt, limit: NonNegativeInt }),
  fairUse: Schema.String,
})

export const getStorageUsage = defineTool({
  name: 'get_storage_usage',
  kind: 'read',
  description: `Your receipt storage use against the fair-use quota (bytes of the receipts you uploaded and have not deleted), plus the groups you created and your API keys against their limits. ${FAIR_USE} To free space, find receipts with list_receipts and delete them with delete_receipts.`,
  input: NoArguments,
  strict: [''],
  output: Usage,
  run: async ({ db, principal }) => ({ ...(await storage.storageUsage(db, { principal })), fairUse: FAIR_USE }),
})

export const listReceipts = defineTool({
  name: 'list_receipts',
  kind: 'read',
  description:
    'List the receipts you uploaded and have not deleted, in groups you belong to, largest first (order=largest, default) or oldest first (order=oldest). Optional groupId, olderThan (upload time) and minBytes filter them. Each has its receiptId for delete_receipts, its group, the expense that shows it (null when none does; deleted=true for a deleted expense), its size, upload time and an authenticated downloadUrl. Follow nextCursor for more.',
  input: Schema.Struct({
    groupId: Schema.optionalKey(ShortId),
    olderThan: Schema.optionalKey(RecordedTime.annotate({ description: 'Only receipts uploaded before this timestamp, e.g. 2026-01-01T00:00:00Z.' })),
    minBytes: Schema.optionalKey(NonNegativeInt),
    order: Schema.optionalKey(Schema.Literals(['largest', 'oldest'])),
    cursor: Schema.optionalKey(NonNegativeInt),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LIMITS.pageMax }))),
  }),
  strict: [''],
  output: Schema.Struct({
    receipts: Schema.Array(
      Schema.Struct({
        receiptId: Id,
        groupId: Id,
        groupName: NullableString.annotate({ description: 'Null for an ungrouped expense.' }),
        expense: Schema.NullOr(Schema.Struct({ id: Id, title: Schema.String, deleted: Schema.Boolean })),
        bytes: NonNegativeInt,
        uploadedAt: DateTime,
        downloadUrl: Schema.String,
      }),
    ),
    hasMore: Schema.Boolean,
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
  run: async ({ db, principal, baseUrl }, input) => {
    const page = await storage.listReceipts(db, {
      principal,
      baseUrl,
      order: input.order ?? 'largest',
      cursor: input.cursor ?? 0,
      limit: input.limit ?? 50,
      groupId: input.groupId,
      olderThan: input.olderThan,
      minBytes: input.minBytes,
    })
    return {
      receipts: page.receipts.map((r) => ({
        receiptId: r.id,
        groupId: r.groupId,
        groupName: r.groupName,
        expense: r.expense,
        bytes: r.bytes,
        uploadedAt: r.createdAt,
        downloadUrl: r.downloadUrl,
      })),
      hasMore: page.nextCursor !== null,
      nextCursor: page.nextCursor,
    }
  },
})

export const deleteReceipts = defineTool({
  name: 'delete_receipts',
  kind: 'write',
  description:
    'Permanently delete receipts by receiptId (from list_receipts, or documents[].receiptId of get_expense). Only the uploader or an admin of the receipt’s group may delete it. The image is removed from storage and frees the uploader’s space. Every current expense that shows it gets a new audited revision without it; history stays append-only, so old revisions and the activity log keep the reference and show it as deleted, and downloads answer 410. This cannot be undone. Download a receipt first if it may be needed. Returns the bytes freed; an already deleted receipt frees 0.',
  input: Schema.Struct({ receiptIds: Schema.Array(ShortId).check(Schema.isBetweenLength(1, LIMITS.pageMax)) }),
  strict: [''],
  output: Schema.Struct({
    deleted: Schema.Array(Schema.Struct({ receiptId: Id, bytes: NonNegativeInt })),
    freedBytes: NonNegativeInt,
    usedBytes: NonNegativeInt.annotate({ description: 'Your receipt storage use after the deletion.' }),
  }),
  run: async ({ db, principal, bucket, afterCommit }, input) => {
    const result = await storage.deleteOwnReceipts(db, { principal, receiptIds: input.receiptIds })
    // The objects leave storage once the deletion is committed; the hourly job retries a failure.
    afterCommit((connection) => storage.purgeDeletedReceipts({ db: connection, bucket, receiptIds: input.receiptIds }))
    return result
  },
})

export const storageTools = [getStorageUsage, listReceipts, deleteReceipts]
