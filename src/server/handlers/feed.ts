import { Effect, Layer } from 'effect'
import * as balances from '../balances'
import * as feed from '../feed'
import { Api, AppConfig, read, write } from '../rpc'
import * as ungrouped from '../ungrouped'

export const FeedHandlers = Layer.mergeAll(
  Api.toLayerHandler('feed.list', ({ filter, cursor, limit }) => read((db, principal) => feed.listFeed(db, { principal, filter, cursor, limit }))),
  Api.toLayerHandler('feed.balances', () => read((db, principal) => balances.accountBalances(db, { principal }))),
  Api.toLayerHandler('feed.options', () => read((db, principal) => feed.feedOptions(db, { principal }))),
  Api.toLayerHandler('expenses.context', ({ expenseId }) => read((db, principal) => feed.expenseContext(db, { principal, expenseId }))),
  Api.toLayerHandler('expenses.createUngrouped', ({ expenseId, idempotencyKey, people, expense }) =>
    Effect.gen(function* () {
      const { baseUrl } = yield* AppConfig
      return yield* write((db, principal) => ungrouped.createUngroupedExpense(db, { principal, baseUrl, expenseId, idempotencyKey, people, expense }))
    }),
  ),
  Api.toLayerHandler('expenses.renewInvitation', ({ groupId, participantId }) =>
    Effect.gen(function* () {
      const { baseUrl } = yield* AppConfig
      return yield* write((db, principal) => ungrouped.renewPrivateInvitation(db, { principal, baseUrl, groupId, participantId }))
    }),
  ),
)
