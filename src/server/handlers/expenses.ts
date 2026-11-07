import { Layer } from 'effect'
import { todayUtc } from '../../shared/dates'
import * as balances from '../balances'
import * as expenses from '../expenses'
import * as recurring from '../recurring'
import { Api, publicRead, read, write } from '../rpc'

export const ExpensesHandlers = Layer.mergeAll(
  Api.toLayerHandler('categories.list', () => publicRead((db) => expenses.listCategories(db))),
  Api.toLayerHandler('reference.get', () => publicRead((db) => expenses.getReference(db))),
  Api.toLayerHandler('expenses.detail', ({ groupId, expenseId }) =>
    read((db, principal) => expenses.getExpenseDetail(db, { principal, groupId, expenseId })),
  ),
  Api.toLayerHandler('expenses.locate', ({ expenseId }) => read((db, principal) => expenses.getExpenseContext(db, { principal, expenseId }))),
  Api.toLayerHandler('balances.list', ({ groupId, currency }) =>
    read((db, principal) => balances.listBalances(db, { principal, groupId, ...(currency ? { currency } : {}) })),
  ),
  Api.toLayerHandler('recurring.list', ({ groupId }) => read((db, principal) => recurring.listRecurring(db, { principal, groupId }))),
  Api.toLayerHandler('recurring.process', ({ groupId }) => write((db, principal) => recurring.processGroup(db, { principal, groupId, today: todayUtc() }))),
)
