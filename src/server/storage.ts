// Storage and limits: the caller's receipt usage and fair-use counts, the list
// of receipts they uploaded, permanent receipt deletion, and the group's
// receipt download. A deleted receipt keeps its row and every history
// snapshot that names it (history is append-only); deleted_receipts records
// the deletion, readers show a tombstone, and the object leaves storage.
import { eq, sql, type SQL } from 'drizzle-orm'
import { deletedReceipts, groups } from '../../db/schema/app'
import { Forbidden, NotFound } from '../shared/api'
import { LIMITS } from '../shared/limits'
import type { Bucket } from './bucket'
import type { Db } from './db'
import { contentDisposition } from './export'
import { removeDocuments, requireMember, type Principal } from './ledger'
import { receiptUsage } from './receipt-quota'
import { receiptDownloadPath, receiptKey } from './receipts'
import { groupsCreated, iso } from './sql'
import { zipStream, type ZipEntry } from './zip'

export const DELETE_DENIED = 'Only the person who uploaded a receipt, or an admin of its group, can delete it.'

/** The caller's usage against each fair-use limit that counts per account. */
export async function storageUsage(db: Db, data: { principal: Principal }) {
  const result = await db.execute<{ bytes: string; count: number; elsewhere: string; groups: number; keys: number }>(sql`
    WITH mine AS (
      SELECT r.bytes, EXISTS (SELECT 1 FROM memberships m WHERE m.group_id = r.group_id AND m.user_id = ${data.principal.userId} AND m.active) AS member
      FROM receipts r
      WHERE r.created_by = ${data.principal.userId} AND NOT EXISTS (SELECT 1 FROM deleted_receipts d WHERE d.receipt_id = r.id)
    )
    SELECT coalesce((SELECT sum(bytes) FROM mine), 0)::text AS bytes,
      (SELECT count(*)::int FROM mine) AS count,
      coalesce((SELECT sum(bytes) FROM mine WHERE NOT member), 0)::text AS elsewhere,
      ${groupsCreated(data.principal.userId)} AS groups,
      (SELECT count(*)::int FROM apikey k WHERE k.reference_id = ${data.principal.userId}) AS keys
  `)
  const row = result.rows[0]
  return {
    receipts: {
      usedBytes: Number(row?.bytes ?? 0),
      limitBytes: LIMITS.receiptStorageBytes,
      count: row?.count ?? 0,
      /** Bytes in groups the caller has left: they count, but only that group's admins can delete them now. */
      elsewhereBytes: Number(row?.elsewhere ?? 0),
    },
    groups: { created: row?.groups ?? 0, limit: LIMITS.groupsCreated },
    apiKeys: { count: row?.keys ?? 0, limit: LIMITS.apiKeys },
  }
}

export type ReceiptOrder = 'largest' | 'oldest'

type ReceiptRow = {
  id: string
  group_id: string
  group_name: string
  group_kind: 'named' | 'private'
  url: string
  bytes: number
  created_at: string
  expense: { id: string; title: string; deleted: boolean } | null
}

/**
 * The receipts that the caller uploaded and has not deleted, in the groups
 * they are still a member of. `expense` is the newest live expense that shows
 * the receipt, else a deleted one, else null (uploaded but not attached).
 */
export async function listReceipts(
  db: Db,
  data: {
    principal: Principal
    order: ReceiptOrder
    cursor: number
    limit: number
    group?: string | undefined
    olderThan?: string | undefined
    minBytes?: number | undefined
    baseUrl?: string | undefined
  },
) {
  const where: SQL[] = [sql`r.created_by = ${data.principal.userId}`, sql`NOT EXISTS (SELECT 1 FROM deleted_receipts d WHERE d.receipt_id = r.id)`]
  if (data.group !== undefined) {
    const { groupId } = await requireMember(db, { principal: data.principal, group: data.group })
    where.push(sql`r.group_id = ${groupId}`)
  }
  if (data.olderThan !== undefined) where.push(sql`r.created_at < ${data.olderThan}::timestamptz`)
  if (data.minBytes !== undefined) where.push(sql`r.bytes >= ${data.minBytes}`)
  const result = await db.execute<ReceiptRow>(sql`
    SELECT r.id, r.group_id, g.name AS group_name, g.kind AS group_kind, r.url, r.bytes, ${iso(sql`r.created_at`)} AS created_at,
      (SELECT json_build_object('id', e.id, 'title', e.title, 'deleted', e.deleted_at IS NOT NULL)
        FROM expense_documents d JOIN expenses e ON e.id = d.expense_id
        WHERE e.group_id = r.group_id AND d.url = r.url
        ORDER BY e.deleted_at IS NULL DESC, e.updated_at DESC, e.id LIMIT 1) AS expense
    FROM receipts r
    JOIN memberships m ON m.group_id = r.group_id AND m.user_id = ${data.principal.userId} AND m.active
    JOIN groups g ON g.id = r.group_id
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY ${data.order === 'largest' ? sql`r.bytes DESC, r.created_at, r.id` : sql`r.created_at, r.id`}
    LIMIT ${data.limit + 1} OFFSET ${data.cursor}
  `)
  const origin = data.baseUrl === undefined ? '' : new URL(data.baseUrl).origin
  return {
    receipts: result.rows.slice(0, data.limit).map((r) => ({
      id: r.id,
      groupId: r.group_id,
      groupName: r.group_kind === 'private' ? null : r.group_name,
      expense: r.expense,
      bytes: r.bytes,
      createdAt: r.created_at,
      downloadUrl: `${origin}${receiptDownloadPath({ groupId: r.group_id, url: r.url })}`,
    })),
    nextCursor: result.rows.length > data.limit ? data.cursor + data.limit : null,
  }
}

type DeleteRow = { id: string; group_id: string; url: string; created_by: string | null; bytes: number; role: 'admin' | 'member' | null; active: boolean; deleted: boolean }

/**
 * Deletes receipts for good, in the caller's transaction. Each receipt must be
 * in a group the caller is an active member of, and the caller must have
 * uploaded it or be an admin of that group. Every live expense that shows a
 * receipt gets a revision without it; deleted expenses and old revisions keep
 * the pointer, which readers show as a tombstone. A receipt that is already
 * deleted frees nothing. Remove the objects after the commit with purgeDeletedReceipts.
 */
export async function deleteReceipts(tx: Db, data: { principal: Principal; receiptIds: readonly string[] }) {
  const ids = [...new Set(data.receiptIds)]
  const { userId } = data.principal
  if (!ids.length) return { deleted: [], freedBytes: 0 }
  const result = await tx.execute<DeleteRow>(sql`
    SELECT r.id, r.group_id, r.url, r.created_by, r.bytes, m.role, coalesce(m.active, false) AS active,
      EXISTS (SELECT 1 FROM deleted_receipts d WHERE d.receipt_id = r.id) AS deleted
    FROM receipts r LEFT JOIN memberships m ON m.group_id = r.group_id AND m.user_id = ${userId}
    WHERE r.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `)
  const byId = new Map(result.rows.map((r) => [r.id, r]))
  // Check every receipt before anything changes. A receipt in a group the caller cannot see looks missing.
  for (const id of ids) {
    const row = byId.get(id)
    if (!row?.active) throw new NotFound({ entity: 'receipt', id })
    if (row.created_by !== userId && row.role !== 'admin') throw new Forbidden({ message: DELETE_DENIED })
  }
  const fresh = result.rows.filter((r) => !r.deleted)
  if (fresh.length) {
    await tx.insert(deletedReceipts).values(fresh.map((r) => ({ receiptId: r.id, deletedBy: userId })))
    const pairs = sql.join(
      fresh.map((r) => sql`(${r.group_id}, ${r.url})`),
      sql`, `,
    )
    const shown = await tx.execute<{ expense_id: string; group_id: string; urls: string[] }>(sql`
      SELECT d.expense_id, e.group_id, array_agg(DISTINCT d.url) AS urls
      FROM expense_documents d JOIN expenses e ON e.id = d.expense_id
      WHERE e.deleted_at IS NULL AND (e.group_id, d.url) IN (VALUES ${pairs})
      GROUP BY d.expense_id, e.group_id ORDER BY d.expense_id
    `)
    for (const row of shown.rows) await removeDocuments(tx, { principal: data.principal, group: row.group_id, expenseId: row.expense_id, urls: new Set(row.urls) })
  }
  const freed = new Set(fresh.map((r) => r.id))
  const deleted = ids.map((id) => ({ receiptId: id, bytes: freed.has(id) ? (byId.get(id)?.bytes ?? 0) : 0 }))
  return { deleted, freedBytes: deleted.reduce((sum, d) => sum + d.bytes, 0) }
}

/** deleteReceipts with the caller's usage after it, for the Settings screen and agents. */
export async function deleteOwnReceipts(tx: Db, data: { principal: Principal; receiptIds: readonly string[] }) {
  const result = await deleteReceipts(tx, data)
  return { ...result, usedBytes: await receiptUsage(tx, data.principal.userId) }
}

/**
 * Removes the objects of deleted receipts from storage and records it. Run it
 * after the deleting transaction commits; the hourly job runs it for every
 * deletion that is still open, so a failed removal is retried. An object that
 * another live receipt row still names stays. Returns the receipts purged.
 */
export async function purgeDeletedReceipts(data: { db: Db; bucket: Bucket; receiptIds?: readonly string[] }): Promise<number> {
  if (data.receiptIds?.length === 0) return 0
  const only = data.receiptIds ? sql`AND d.receipt_id IN (${sql.join(data.receiptIds.map((id) => sql`${id}`), sql`, `)})` : sql``
  const open = await data.db.execute<{ id: string; url: string; shared: boolean }>(sql`
    SELECT d.receipt_id AS id, r.url,
      EXISTS (SELECT 1 FROM receipts o WHERE o.url = r.url AND o.id <> r.id
        AND NOT EXISTS (SELECT 1 FROM deleted_receipts x WHERE x.receipt_id = o.id)) AS shared
    FROM deleted_receipts d JOIN receipts r ON r.id = d.receipt_id
    WHERE d.purged_at IS NULL ${only}
    ORDER BY d.deleted_at LIMIT 500
  `)
  let purged = 0
  for (const row of open.rows) {
    const key = receiptKey(row.url)
    try {
      if (key && !row.shared) await data.bucket.delete(key)
    } catch (error) {
      console.error('Removing a deleted receipt from storage failed; the hourly job retries it', { receiptId: row.id }, error)
      continue
    }
    await data.db.update(deletedReceipts).set({ purgedAt: sql`now()` }).where(eq(deletedReceipts.receiptId, row.id))
    purged++
  }
  return purged
}

// ---------- the group's receipt download ----------

export type ArchiveEntry = { name: string; key: string; time: Date }

type ArchiveRow = { url: string; created_at: string; expense: { date: string; title: string; live: boolean } | null }

/** A file name without path separators, control characters or characters that Windows refuses. */
const safeName = (text: string) =>
  text
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'receipt'

/**
 * The receipts of a group that members can download, deleted ones left out,
 * each with a file name: "<expense date> <title>.<ext>" for a live expense,
 * under "Deleted expenses/" for a deleted one, and under "Not attached/" for a
 * receipt that no expense shows now. Checks membership.
 */
export async function receiptArchive(db: Db, data: { principal: Principal; group: string }) {
  const { groupId } = await requireMember(db, data)
  const result = await db.execute<ArchiveRow>(sql`
    SELECT x.url, ${iso(sql`min(x.created_at)`)} AS created_at,
      (SELECT json_build_object('date', e.expense_date::text, 'title', e.title, 'live', e.deleted_at IS NULL)
        FROM expense_documents d JOIN expenses e ON e.id = d.expense_id
        WHERE e.group_id = ${groupId} AND d.url = x.url
        ORDER BY e.deleted_at IS NULL DESC, e.expense_date DESC, e.id LIMIT 1) AS expense
    FROM (
      SELECT r.url, r.created_at FROM receipts r WHERE r.group_id = ${groupId}
      UNION ALL
      SELECT d.url, e.created_at FROM expense_documents d JOIN expenses e ON e.id = d.expense_id WHERE e.group_id = ${groupId}
    ) x
    WHERE NOT EXISTS (SELECT 1 FROM receipts r JOIN deleted_receipts dr ON dr.receipt_id = r.id WHERE r.group_id = ${groupId} AND r.url = x.url)
    GROUP BY x.url
    ORDER BY min(x.created_at), x.url
  `)
  const used = new Set<string>()
  const entries: ArchiveEntry[] = []
  for (const row of result.rows) {
    const key = receiptKey(row.url)
    if (!key) continue
    const ext = /\.png$/i.test(key) ? 'png' : 'jpg'
    const base = row.expense
      ? `${row.expense.live ? '' : 'Deleted expenses/'}${row.expense.date} ${safeName(row.expense.title)}`
      : `Not attached/${row.created_at.slice(0, 10)} receipt`
    let name = `${base}.${ext}`
    for (let n = 2; used.has(name); n++) name = `${base} (${n}).${ext}`
    used.add(name)
    entries.push({ name, key, time: new Date(row.created_at) })
  }
  const [group] = await db.select({ name: groups.name }).from(groups).where(eq(groups.id, groupId))
  return { groupName: group?.name ?? groupId, entries }
}

/**
 * The HTTP response of the receipt download: a ZIP file that streams from
 * storage after the database work is done. A receipt whose object is missing
 * is listed in MISSING.txt at the end of the file instead.
 */
export function receiptArchiveResponse(data: { bucket: Bucket; archive: Awaited<ReturnType<typeof receiptArchive>>; date: string }) {
  const { bucket, archive } = data
  async function* files(): AsyncGenerator<ZipEntry | null> {
    const missing: string[] = []
    for (const entry of archive.entries) {
      const object = await bucket.get(entry.key)
      if (!object) {
        missing.push(entry.name)
        yield null
        continue
      }
      yield { name: entry.name, time: entry.time, bytes: await object.bytes() }
    }
    if (missing.length)
      yield { name: 'MISSING.txt', time: new Date(), bytes: new TextEncoder().encode(`These receipts were not found in storage:\n${missing.join('\n')}\n`) }
  }
  return new Response(zipStream(files()), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(`${archive.groupName} receipts ${data.date}.zip`),
      'Cache-Control': 'private, no-store',
    },
  })
}
