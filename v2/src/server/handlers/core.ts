import { Effect, Layer } from 'effect'
import * as ledger from '../ledger'
import { Api, currentPrincipal, read, write } from '../rpc'

export const CoreHandlers = Layer.mergeAll(
  Api.toLayerHandler('session.me', () =>
    Effect.map(currentPrincipal, (p) => (p ? { userId: p.userId, name: p.name, email: p.email } : null)),
  ),
  Api.toLayerHandler('groups.list', () => read((db, principal) => ledger.listGroups(db, principal))),
  Api.toLayerHandler('groups.get', ({ groupId }) => read((db, principal) => ledger.getGroup(db, { principal, group: groupId }))),
  Api.toLayerHandler('expenses.list', ({ groupId, filter, cursor, limit }) =>
    read((db, principal) => ledger.listExpenses(db, { principal, group: groupId, filter, cursor, limit })),
  ),
  Api.toLayerHandler('expenses.get', ({ groupId, expenseId }) =>
    read((db, principal) => ledger.getExpense(db, { principal, group: groupId, expenseId })),
  ),
  Api.toLayerHandler('expenses.create', ({ groupId, expenseId, idempotencyKey, expense }) =>
    write((db, principal) => ledger.createExpense(db, { principal, group: groupId, expenseId, idempotencyKey, expense })),
  ),
  Api.toLayerHandler('expenses.update', ({ groupId, expenseId, expectedRevision, idempotencyKey, expense }) =>
    write((db, principal) => ledger.updateExpense(db, { principal, group: groupId, expenseId, expectedRevision, idempotencyKey, expense })),
  ),
  Api.toLayerHandler('expenses.delete', ({ groupId, expenseId, expectedRevision, idempotencyKey }) =>
    write((db, principal) => ledger.deleteExpense(db, { principal, group: groupId, expenseId, expectedRevision, idempotencyKey })),
  ),
)
