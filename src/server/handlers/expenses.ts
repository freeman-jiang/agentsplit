import { Effect, Layer } from 'effect'
import * as expenses from '../expenses'
import * as recurring from '../recurring'
import { Api, AppConfig, read } from '../rpc'
import { useDb } from '../db'
import { Unavailable } from '../../shared/api'

const today = () => new Date().toISOString().slice(0, 10)

/** Public reference data: no principal needed, and no access to check. */
const reference = <A>(work: Parameters<typeof useDb<A>>[0]) =>
  useDb(work).pipe(Effect.mapError((e) => new Unavailable({ message: e instanceof Error ? e.message : 'The request failed' })))

export const ExpensesHandlers = Layer.mergeAll(
  Api.toLayerHandler('categories.list', () => reference((db) => expenses.listCategories(db))),
  Api.toLayerHandler('reference.get', () =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      return yield* reference((db) => expenses.getReference(db, { documentsEnabled: config.documentsEnabled }))
    }),
  ),
  Api.toLayerHandler('expenses.detail', ({ groupId, expenseId }) =>
    read((db, principal) => expenses.getExpenseDetail(db, { principal, group: groupId, expenseId })),
  ),
  Api.toLayerHandler('expenses.locate', ({ expenseId }) => read((db, principal) => expenses.getExpenseContext(db, { principal, expenseId }))),
  Api.toLayerHandler('balances.list', ({ groupId, currency }) =>
    read((db, principal) => expenses.listBalances(db, { principal, group: groupId, ...(currency ? { currency } : {}) })),
  ),
  Api.toLayerHandler('recurring.list', ({ groupId }) => read((db, principal) => recurring.listRecurring(db, { principal, group: groupId }))),
  // Each occurrence is its own SERIALIZABLE transaction, as in the scheduled job.
  Api.toLayerHandler('recurring.process', ({ groupId }) =>
    read((db, principal) =>
      recurring.processGroup(db, {
        principal,
        group: groupId,
        today: today(),
        transaction: (work) => db.transaction(work, { isolationLevel: 'serializable' }),
      }),
    ),
  ),
)
