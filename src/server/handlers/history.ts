import { Layer } from 'effect'
import * as balances from '../balances'
import * as exports from '../export'
import * as history from '../history'
import { Api, read } from '../rpc'
import * as stats from '../stats'

export const HistoryHandlers = Layer.mergeAll(
  Api.toLayerHandler('history.activities', ({ groupId, ...query }) => read((db, principal) => history.listActivities(db, { principal, groupId, ...query }))),
  Api.toLayerHandler('history.expense', ({ groupId, ...selection }) => read((db, principal) => history.getSavedExpense(db, { principal, groupId, ...selection }))),
  Api.toLayerHandler('history.expenses', ({ groupId, ...query }) => read((db, principal) => history.listSavedExpenses(db, { principal, groupId, ...query }))),
  Api.toLayerHandler('history.balances', ({ groupId, ...selection }) => read((db, principal) => balances.savedBalances(db, { principal, groupId, ...selection }))),
  Api.toLayerHandler('stats.overview', ({ groupId, ...scope }) => read((db, principal) => stats.statsOverview(db, { principal, groupId, ...scope }))),
  Api.toLayerHandler('stats.expenses', ({ groupId, ...scope }) => read((db, principal) => stats.statsExpenses(db, { principal, groupId, ...scope }))),
  Api.toLayerHandler('export.group', ({ groupId, format }) => read((db, principal) => exports.exportFile(db, { principal, groupId, format }))),
)
