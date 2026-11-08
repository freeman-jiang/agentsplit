import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as app from '../../../db/schema/app'
import * as auth from '../../../db/schema/auth'

export const schema = { ...app, ...auth }
export type Db = NodePgDatabase<typeof schema>

// Expense dates are calendar dates: keep DATE as text, never a local Date.
pg.types.setTypeParser(1082, (value: string) => value)

export const makeDb = (client: pg.Client | pg.PoolClient | pg.Pool): Db => drizzle({ client, schema, casing: 'snake_case' })

/** The app's advisory lock keys (the owner bootstrap takes one key, a quota decision two), one per kind of decision; no two may be equal. */
export const ADVISORY_LOCKS = { ownerBootstrap: 170031011, receiptQuota: 170031012 } as const

/** Writes that conflict with a concurrent write (serialization failure or deadlock) are retried. */
const RETRYABLE = new Set(['40001', '40P01'])
/** The SQLSTATE of a failed statement, or undefined for anything else. */
export const sqlState = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  const { code, cause } = error as { code?: unknown; cause?: unknown }
  // Drizzle wraps the driver's error, so the SQLSTATE is on its cause.
  return typeof code === 'string' ? code : sqlState(cause)
}
/** True for a write conflict with a concurrent write. The transaction rolled back, so nothing changed. */
export const retryable = (cause: unknown) => RETRYABLE.has(sqlState(cause) ?? '')

/** The attempts of one SERIALIZABLE transaction. */
const ATTEMPTS = 10
/**
 * The pause before retry `n` (0 for the first retry): a random time up to
 * 8 ms × 2^n, at most 320 ms ("full jitter"). Without a pause, the
 * transactions that collided start again together and collide again. The
 * pauses of all 9 retries add up to at most 1.5 s.
 */
const pause = (n: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.random() * Math.min(320, 8 * 2 ** n)))

/**
 * Runs `work` in one SERIALIZABLE transaction on `db`, in up to 10 attempts on
 * serialization failures, with a random pause before each retry. After the
 * last attempt the error goes to the caller (calls.ts answers it as busy).
 */
export async function serializable<A>(db: Db, work: (tx: Db) => Promise<A>): Promise<A> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(work, { isolationLevel: 'serializable' })
    } catch (error) {
      if (attempt >= ATTEMPTS || !retryable(error)) throw error
      await pause(attempt - 1)
    }
  }
}
