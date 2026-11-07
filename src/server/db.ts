import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as app from '../../db/schema/app'
import * as auth from '../../db/schema/auth'

export const schema = { ...app, ...auth }
export type Db = NodePgDatabase<typeof schema>

// Expense dates are calendar dates: keep DATE as text, never a local Date.
pg.types.setTypeParser(1082, (value: string) => value)

export const makeDb = (client: pg.Client | pg.PoolClient | pg.Pool): Db => drizzle({ client, schema, casing: 'snake_case' })

/** Writes that conflict with a concurrent write (serialization failure or deadlock) are retried. */
const RETRYABLE = new Set(['40001', '40P01'])
/** The SQLSTATE of a failed statement, or undefined for anything else. */
export const sqlState = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  const { code, cause } = error as { code?: unknown; cause?: unknown }
  // Drizzle wraps the driver's error, so the SQLSTATE is on its cause.
  return typeof code === 'string' ? code : sqlState(cause)
}
const retryable = (cause: unknown) => RETRYABLE.has(sqlState(cause) ?? '')

/** Runs `work` in one SERIALIZABLE transaction on `db`, retried up to 4 times on serialization failures. */
export async function serializable<A>(db: Db, work: (tx: Db) => Promise<A>): Promise<A> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(work, { isolationLevel: 'serializable' })
    } catch (error) {
      if (attempt >= 4 || !retryable(error)) throw error
    }
  }
}
