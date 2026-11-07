// The RPC side of a call: the session check once per call, then the domain
// work through src/server/calls.ts. The handlers in src/server/handlers/ use
// `read`, `write` and `publicRead`.
import { Cause, Context, Effect, Layer, Option } from 'effect'
import { RpcMiddleware } from 'effect/rpc'
import { AgentSplitApi, Unauthorized, Unavailable } from '../shared/api'
import { ERROR_ANSWERS, errorKind, UNAVAILABLE, type DeclaredError } from '../shared/errors'
import type { Principal } from './access'
import { sessionPrincipal } from './auth/session'
import type { Bucket } from './bucket'
import { answerOf, readAnswerOf, runRead, runWrite, type AfterCommit, type CallName } from './calls'
import type { Db } from './db'

/** The settings that the handlers and the session check use. */
export class AppConfig extends Context.Service<AppConfig, { readonly baseUrl: string; readonly secret: string }>()('agentsplit/AppConfig') {}

/** The receipts bucket, for handlers that remove receipts from storage after their write commits. */
export class ReceiptBucket extends Context.Service<ReceiptBucket, Bucket>()('agentsplit/ReceiptBucket') {}

/**
 * This request's database connection and ID. The server's request handler
 * (app.ts) puts it in the request's context; the RPC server runs every call
 * of the request with that context, so the middleware reads it from there.
 */
export class RpcRequest extends Context.Service<RpcRequest, { readonly db: Db; readonly requestId: string }>()('agentsplit/RpcRequest') {}

/** One call: the request's connection, its name for the log, and the signed-in caller or null. */
export class CurrentCall extends Context.Service<CurrentCall, { readonly db: Db; readonly call: CallName; readonly principal: Principal | null }>()(
  'agentsplit/CurrentCall',
) {}

export class AuthMiddleware extends RpcMiddleware.Service<AuthMiddleware, { provides: CurrentCall }>()('agentsplit/AuthMiddleware', { error: Unavailable }) {}

const isDeclared = (error: unknown): error is DeclaredError =>
  typeof error === 'object' && error !== null && '_tag' in error && typeof error._tag === 'string' && Object.hasOwn(ERROR_ANSWERS, error._tag)

/**
 * Logs a failed call with the request ID that the response header carries and
 * the error page shows, so a quoted reference finds its log line. The cause of
 * an Unavailable was logged where it happened (calls.ts).
 */
const logFailure = (data: { call: CallName; cause: Cause.Cause<unknown> }) =>
  Effect.sync(() => {
    if (Cause.hasInterruptsOnly(data.cause)) return
    const error = Cause.findErrorOption(data.cause)
    const meta = { requestId: data.call.requestId }
    if (Option.isNone(error) || !isDeclared(error.value)) return console.error(`${data.call.name} failed`, meta, Cause.pretty(data.cause))
    const tag = error.value._tag
    if (ERROR_ANSWERS[errorKind(error.value)].answer) console.warn(`${data.call.name} answered ${tag}`, meta)
    else console.error(`${data.call.name} answered ${tag}`, meta)
  })

export const AuthMiddlewareLive = Layer.effect(AuthMiddleware)(
  Effect.gen(function* () {
    const config = yield* AppConfig
    return (effect, { headers, rpc }) =>
      Effect.gen(function* () {
        const request = yield* Effect.serviceOption(RpcRequest)
        const call: CallName = { name: `RPC ${rpc._tag}`, requestId: Option.isSome(request) ? request.value.requestId : undefined }
        if (Option.isNone(request)) {
          console.error(`${call.name}: no database connection for this request`)
          return yield* Effect.fail(new Unavailable({ message: UNAVAILABLE }))
        }
        const { db } = request.value
        const cookie = (headers as Record<string, string | undefined>)['cookie'] ?? null
        const principal = yield* Effect.tryPromise({
          try: () => sessionPrincipal(db, { cookie, secret: config.secret, baseUrl: config.baseUrl }),
          catch: (error) => {
            console.error(`${call.name}: the session check failed`, { requestId: call.requestId }, error)
            return new Unavailable({ message: UNAVAILABLE })
          },
        })
        return yield* effect.pipe(Effect.provideService(CurrentCall, { db, call, principal }), Effect.tapCause((cause) => logFailure({ call, cause })))
      })
  }),
)

export const currentPrincipal = Effect.map(CurrentCall, (current) => current.principal)

const signedIn = Effect.flatMap(CurrentCall, (current) =>
  current.principal ? Effect.succeed({ ...current, principal: current.principal }) : Effect.fail(new Unauthorized()),
)

/** Public reference data: no principal needed, and no access to check. Its only failure is Unavailable. */
export const publicRead = <A>(work: (db: Db) => Promise<A>) =>
  Effect.flatMap(CurrentCall, ({ db, call }) =>
    Effect.tryPromise({
      try: () => runRead({ db, call, work }),
      catch: (error) => {
        const answer = readAnswerOf(error, call)
        return answer instanceof Unavailable ? answer : new Unavailable({ message: UNAVAILABLE })
      },
    }),
  )

/** A read on this request's connection, for a signed-in caller. */
export const read = <A>(work: (db: Db, principal: Principal) => Promise<A>) =>
  Effect.flatMap(signedIn, ({ db, call, principal }) =>
    Effect.tryPromise({ try: () => runRead({ db, call, work: (d) => work(d, principal) }), catch: (error) => readAnswerOf(error, call) }),
  )

/** A write for a signed-in caller, with the write budget and one SERIALIZABLE transaction (calls.ts). */
export const write = <A>(work: (db: Db, principal: Principal, afterCommit: AfterCommit) => Promise<A>) =>
  Effect.flatMap(signedIn, ({ db, call, principal }) =>
    Effect.tryPromise({
      try: () => runWrite({ db, principal, call, work: (tx, afterCommit) => work(tx, principal, afterCommit) }),
      catch: (error) => answerOf(error, call),
    }),
  )

export const Api = AgentSplitApi.middleware(AuthMiddleware)
