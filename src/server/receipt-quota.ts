// The receipt storage quota (LIMITS.receiptStorageBytes). A receipt counts
// against the account that uploaded it until it is deleted for good. Receipts
// without a known uploader (imported from before accounts) count against no one.
import { sql } from 'drizzle-orm'
import { LIMITS, storageFullMessage } from '../shared/limits'
import { ADVISORY_LOCKS, type Db } from './core/db'

/** The bytes that count against `userId`. */
export async function receiptUsage(db: Db, userId: string): Promise<number> {
  const result = await db.execute<{ bytes: string }>(sql`
    SELECT coalesce(sum(r.bytes), 0)::text AS bytes FROM receipts r
    WHERE r.created_by = ${userId} AND NOT EXISTS (SELECT 1 FROM deleted_receipts d WHERE d.receipt_id = r.id)
  `)
  return Number(result.rows[0]?.bytes ?? 0)
}

/**
 * Null when `bytes` more fit the user's storage, else the message to show.
 * `lock` takes the user's quota lock until the transaction ends, so two
 * concurrent uploads decide one after the other and cannot both pass on the
 * same free space; use it where the receipt row is written. `outstanding`
 * also counts the user's agent uploads that may still be attached: a soft
 * check when upload targets are issued.
 */
export async function spaceFor(tx: Db, data: { userId: string; bytes: number; lock: boolean; outstanding: boolean }): Promise<string | null> {
  if (data.lock) await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCKS.receiptQuota}, hashtext(${data.userId}))`)
  const used = await receiptUsage(tx, data.userId)
  let pending = 0
  if (data.outstanding) {
    const result = await tx.execute<{ bytes: string }>(sql`
      SELECT coalesce(sum(u.bytes), 0)::text AS bytes FROM receipt_uploads u
      WHERE u.user_id = ${data.userId} AND (u.state <> 'pending' OR u.expires_at > now())
    `)
    pending = Number(result.rows[0]?.bytes ?? 0)
  }
  return used + pending + data.bytes <= LIMITS.receiptStorageBytes ? null : storageFullMessage(used)
}
