import { Cause, Context, Effect, Layer, Option } from 'effect'
import { RpcMiddleware } from 'effect/rpc'
import { AgentSplitApi, Conflict, Unauthorized, Unavailable } from '../shared/api'
import { DatabaseError, REQUEST_ID_HEADER, RequestDb, requestDbFor, transaction, useDb, type Db, type DomainError } from './db'
import type * as ledger from './ledger'
import { sessionPrincipal } from './session'

/** Settings from the server environment that the handlers need. */
export class AppConfig extends Context.Service<
  AppConfig,
  {
    readonly baseUrl: string
    readonly secret: string
    readonly googleClientId: string
    readonly googleClientSecret: string
    /** Receipts on expenses (the current app's ENABLE_EXPENSE_DOCUMENTS). */
    readonly documentsEnabled: boolean
  }
>()('agentsplit/AppConfig') {}

/** The signed-in caller, or null. Resolved once per request by AuthMiddleware. */
export class CurrentPrincipal extends Context.Service<CurrentPrincipal, ledger.Principal | null>()('agentsplit/CurrentPrincipal') {}

export class AuthMiddleware extends RpcMiddleware.Service<AuthMiddleware, { provides: CurrentPrincipal | RequestDb }>()(
  'agentsplit/AuthMiddleware',
  { error: Unavailable },
) {}

const unavailable = (error: DatabaseError | DomainError) => new Unavailable({ message: error instanceof DatabaseError ? error.message : 'Sign-in check failed' })

/** Declared errors that answer the caller's own request. Every other failure is the server's. */
const ANSWERS: ReadonlySet<string> = new Set(['Unauthorized', 'Forbidden', 'NotFound', 'Conflict', 'Invalid'])

/**
 * Logs a failed call with the request ID that the response header carries and
 * the error page shows, so a quoted reference finds its log line.
 */
const logFailure = (data: { requestId: string | undefined; rpc: string; cause: Cause.Cause<unknown> }) =>
  Effect.sync(() => {
    if (Cause.hasInterruptsOnly(data.cause)) return
    const error = Cause.findErrorOption(data.cause)
    const tag = Option.isSome(error) && typeof error.value === 'object' && error.value !== null && '_tag' in error.value ? String(error.value._tag) : null
    if (tag !== null && ANSWERS.has(tag)) console.warn(`RPC ${data.rpc} answered ${tag}`, { requestId: data.requestId })
    else console.error(`RPC ${data.rpc} failed`, { requestId: data.requestId }, Cause.pretty(data.cause))
  })

export const AuthMiddlewareLive = Layer.effect(AuthMiddleware)(
  Effect.gen(function* () {
    const config = yield* AppConfig
    return (effect, { headers, rpc }) => {
      const values = headers as Record<string, string | undefined>
      const requestId = values[REQUEST_ID_HEADER]
      const db = requestDbFor(requestId)
      const call = db
        ? Effect.flatMap(
            useDb((d) => sessionPrincipal(d, { cookie: values['cookie'] ?? null, secret: config.secret, baseUrl: config.baseUrl })).pipe(
              Effect.provideService(RequestDb, db),
              Effect.mapError(unavailable),
            ),
            (principal) => effect.pipe(Effect.provideService(CurrentPrincipal, principal), Effect.provideService(RequestDb, db)),
          )
        : Effect.fail(new Unavailable({ message: 'No database connection for this request' }))
      return Effect.tapCause(call, (cause) => logFailure({ requestId, rpc: rpc._tag, cause }))
    }
  }),
)

export const currentPrincipal = Effect.gen(function* () {
  return yield* CurrentPrincipal
})
export const requirePrincipal = Effect.flatMap(currentPrincipal, (p) => (p ? Effect.succeed(p) : Effect.fail(new Unauthorized())))

/** Maps a database failure to Unavailable; domain errors pass through. */
const run = <A, R>(effect: Effect.Effect<A, DatabaseError | DomainError, R>) =>
  Effect.mapError(effect, (e) => (e instanceof DatabaseError ? new Unavailable({ message: e.message }) : e))

/** A read on this request's connection, for a signed-in caller. */
export const read = <A>(work: (db: Db, principal: ledger.Principal) => Promise<A>) =>
  Effect.flatMap(requirePrincipal, (principal) =>
    run(useDb((db) => work(db, principal))).pipe(
      // Reads never check revisions; a Conflict here would be a bug, so report it as a failure.
      Effect.mapError((e) => (e instanceof Conflict ? new Unavailable({ message: 'Unexpected conflict on a read' }) : e)),
    ),
  )
/** A write in one SERIALIZABLE transaction, for a signed-in caller. */
export const write = <A>(work: (db: Db, principal: ledger.Principal) => Promise<A>) =>
  Effect.flatMap(requirePrincipal, (principal) => run(transaction((db) => work(db, principal))))

export const Api = AgentSplitApi.middleware(AuthMiddleware)
