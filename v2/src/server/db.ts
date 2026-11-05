import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Context, Effect, Layer, Schema } from 'effect'
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

/** Writes that conflict with a concurrent write (serialization failure or deadlock) are retried. */
const RETRYABLE = new Set(['40001', '40P01'])

export class Database extends Context.Service<
  Database,
  {
    /** Runs `work` on one connection. */
    readonly use: <A>(work: (db: Db) => Promise<A>) => Effect.Effect<A, DatabaseError | DomainError>
    /** Runs `work` in one SERIALIZABLE transaction, retried on serialization failures. */
    readonly transaction: <A>(work: (db: Db) => Promise<A>) => Effect.Effect<A, DatabaseError | DomainError>
  }
>()('agentsplit/Database') {}

/** Errors the domain code throws on purpose. They pass through unchanged; anything else is a DatabaseError. */
export type DomainError = Forbidden | NotFound | Conflict | Invalid
const isDomainError = (cause: unknown): cause is DomainError =>
  cause instanceof Forbidden || cause instanceof NotFound || cause instanceof Conflict || cause instanceof Invalid

const errorOf = (cause: unknown): DatabaseError | DomainError =>
  isDomainError(cause) ? cause : new DatabaseError({ message: cause instanceof Error ? cause.message : String(cause) })

/** One connection per call. Hyperdrive pools the real connections, so connecting is cheap. */
export function databaseLayer(connectionString: () => string) {
  const connect = Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const client = new pg.Client({ connectionString: connectionString() })
        await client.connect()
        return client
      },
      catch: errorOf,
    }),
    (client) => Effect.promise(() => client.end().catch(() => {})),
  )
  const use = <A>(work: (db: Db) => Promise<A>) =>
    Effect.scoped(Effect.flatMap(connect, (client) => Effect.tryPromise({ try: () => work(makeDb(client)), catch: errorOf })))
  const attempt = <A>(work: (db: Db) => Promise<A>) =>
    Effect.scoped(
      Effect.flatMap(connect, (client) =>
        Effect.tryPromise({
          try: () => makeDb(client).transaction(work, { isolationLevel: 'serializable' }),
          catch: (cause) => cause,
        }),
      ),
    )
  const transaction = <A>(work: (db: Db) => Promise<A>): Effect.Effect<A, DatabaseError | DomainError> =>
    attempt(work).pipe(
      Effect.retry({
        times: 4,
        while: (cause) => typeof cause === 'object' && cause !== null && RETRYABLE.has(String((cause as { code?: unknown }).code)),
      }),
      Effect.mapError((cause) => (cause instanceof DatabaseError ? cause : errorOf(cause))),
    )
  return Layer.succeed(Database, { use, transaction })
}
