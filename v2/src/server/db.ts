import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Context, Effect, Schema } from 'effect'
import pg from 'pg'
import * as app from '../../db/schema/app'
import * as auth from '../../db/schema/auth'
import { Conflict, Forbidden, Invalid, NotFound } from '../shared/api'

export const schema = { ...app, ...auth }
export type Db = NodePgDatabase<typeof schema>

// Expense dates are calendar dates: keep DATE as text, never a local Date.
pg.types.setTypeParser(1082, (value: string) => value)

export const makeDb = (client: pg.Client | pg.PoolClient): Db => drizzle({ client, schema, casing: 'snake_case' })

export class DatabaseError extends Schema.TaggedError<DatabaseError>()('DatabaseError', { message: Schema.String }) {}

/** Errors the domain code throws on purpose. They pass through unchanged; anything else is a DatabaseError. */
export type DomainError = Forbidden | NotFound | Conflict | Invalid
const isDomainError = (cause: unknown): cause is DomainError =>
  cause instanceof Forbidden || cause instanceof NotFound || cause instanceof Conflict || cause instanceof Invalid

const errorOf = (cause: unknown): DatabaseError | DomainError =>
  isDomainError(cause) ? cause : new DatabaseError({ message: cause instanceof Error ? cause.message : String(cause) })

/**
 * This request's database connection. The Worker opens one connection per
 * request and registers it under a random ID that only it can set (the
 * x-agentsplit-request header); the RPC middleware provides it to handlers.
 */
export class RequestDb extends Context.Service<RequestDb, Db>()('agentsplit/RequestDb') {}

export const REQUEST_ID_HEADER = 'x-agentsplit-request'
const connections = new Map<string, Db>()
export const registerRequestDb = (id: string, db: Db) => void connections.set(id, db)
export const releaseRequestDb = (id: string) => void connections.delete(id)
export const requestDbFor = (id: string | undefined) => (id ? connections.get(id) : undefined)

/** Runs `work` on this request's connection. */
export const useDb = <A>(work: (db: Db) => Promise<A>): Effect.Effect<A, DatabaseError | DomainError, RequestDb> =>
  Effect.gen(function* () {
    const db = yield* RequestDb
    return yield* Effect.tryPromise({ try: () => work(db), catch: errorOf })
  })

/** Writes that conflict with a concurrent write (serialization failure or deadlock) are retried. */
const RETRYABLE = new Set(['40001', '40P01'])
const retryable = (cause: unknown) => typeof cause === 'object' && cause !== null && RETRYABLE.has(String((cause as { code?: unknown }).code))

/** Runs `work` in one SERIALIZABLE transaction on this request's connection, retried on serialization failures. */
export const transaction = <A>(work: (db: Db) => Promise<A>): Effect.Effect<A, DatabaseError | DomainError, RequestDb> =>
  Effect.gen(function* () {
    const db = yield* RequestDb
    return yield* Effect.tryPromise({ try: () => db.transaction(work, { isolationLevel: 'serializable' }), catch: (cause) => cause }).pipe(
      Effect.retry({ times: 4, while: retryable }),
      Effect.mapError(errorOf),
    )
  })
