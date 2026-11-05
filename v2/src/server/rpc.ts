import { Context, Effect, Layer } from 'effect'
import { RpcMiddleware } from 'effect/rpc'
import { AgentSplitApi, Conflict, Unauthorized, Unavailable } from '../shared/api'
import { createAuth, type AuthConfig } from './auth'
import { Database, DatabaseError, type Db, type DomainError } from './db'
import * as ledger from './ledger'

/** Settings from the Worker environment that the handlers need. */
export class AppConfig extends Context.Service<AppConfig, Omit<AuthConfig, 'db'>>()('agentsplit/AppConfig') {}

/** The signed-in caller, or null. Resolved once per request by AuthMiddleware. */
export class CurrentPrincipal extends Context.Service<CurrentPrincipal, ledger.Principal | null>()('agentsplit/CurrentPrincipal') {}

export class AuthMiddleware extends RpcMiddleware.Service<AuthMiddleware, { provides: CurrentPrincipal }>()('agentsplit/AuthMiddleware', {
  error: Unavailable,
}) {}

/** The web session's principal: a verified Google account. */
export async function sessionPrincipal(db: Db, config: Omit<AuthConfig, 'db'>, headers: Headers): Promise<ledger.Principal | null> {
  const session = await createAuth({ ...config, db }).api.getSession({ headers })
  if (!session?.user.emailVerified) return null
  return { userId: session.user.id, name: session.user.name, email: session.user.email, source: 'web', agentKeyId: null }
}

const unavailable = (error: DatabaseError) => new Unavailable({ message: error.message })

export const AuthMiddlewareLive = Layer.effect(AuthMiddleware)(
  Effect.gen(function* () {
    const database = yield* Database
    const config = yield* AppConfig
    return (effect, { headers }) =>
      Effect.flatMap(
        database.use((db) => sessionPrincipal(db, config, new Headers(headers as Record<string, string>))).pipe(
          Effect.mapError((e) => (e instanceof DatabaseError ? unavailable(e) : new Unavailable({ message: 'Sign-in check failed' }))),
        ),
        (principal) => Effect.provideService(effect, CurrentPrincipal, principal),
      )
  }),
)

const currentPrincipal = Effect.gen(function* () {
  return yield* CurrentPrincipal
})
const requirePrincipal = Effect.flatMap(currentPrincipal, (p) => (p ? Effect.succeed(p) : Effect.fail(new Unauthorized())))

/** Maps a database failure to Unavailable; domain errors pass through. */
const run = <A>(effect: Effect.Effect<A, DatabaseError | DomainError>) =>
  Effect.mapError(effect, (e) => (e instanceof DatabaseError ? unavailable(e) : e))

export const Api = AgentSplitApi.middleware(AuthMiddleware)

export const HandlersLive = Api.toLayer(
  Effect.gen(function* () {
    const database = yield* Database
    const read = <A>(work: (db: Db, principal: ledger.Principal) => Promise<A>) =>
      Effect.flatMap(requirePrincipal, (principal) =>
        run(database.use((db) => work(db, principal))).pipe(
          // Reads never check revisions; a Conflict here would be a bug, so report it as a failure.
          Effect.mapError((e) => (e instanceof Conflict ? new Unavailable({ message: 'Unexpected conflict on a read' }) : e)),
        ),
      )
    const write = <A>(work: (db: Db, principal: ledger.Principal) => Promise<A>) =>
      Effect.flatMap(requirePrincipal, (principal) => run(database.transaction((db) => work(db, principal))))
    return {
      'session.me': () =>
        Effect.map(currentPrincipal, (p) => (p ? { userId: p.userId, name: p.name, email: p.email } : null)),
      'groups.list': () => read((db, principal) => ledger.listGroups(db, principal)),
      'groups.get': ({ groupId }) => read((db, principal) => ledger.getGroup(db, { principal, group: groupId })),
      'expenses.list': ({ groupId, filter, cursor, limit }) =>
        read((db, principal) => ledger.listExpenses(db, { principal, group: groupId, filter, cursor, limit })),
      'expenses.get': ({ groupId, expenseId }) => read((db, principal) => ledger.getExpense(db, { principal, group: groupId, expenseId })),
      'expenses.create': ({ groupId, expenseId, idempotencyKey, expense }) =>
        write((db, principal) => ledger.createExpense(db, { principal, group: groupId, expenseId, idempotencyKey, expense })),
      'expenses.update': ({ groupId, expenseId, expectedRevision, idempotencyKey, expense }) =>
        write((db, principal) => ledger.updateExpense(db, { principal, group: groupId, expenseId, expectedRevision, idempotencyKey, expense })),
      'expenses.delete': ({ groupId, expenseId, expectedRevision, idempotencyKey }) =>
        write((db, principal) => ledger.deleteExpense(db, { principal, group: groupId, expenseId, expectedRevision, idempotencyKey })),
    }
  }),
)
