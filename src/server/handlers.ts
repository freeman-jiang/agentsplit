// Every area's RPC handlers, merged. Each area registers its handlers in src/server/handlers/.
import { Layer } from 'effect'
import { AccountHandlers } from './handlers/account'
import { CoreHandlers } from './handlers/core'
import { ExpensesHandlers } from './handlers/expenses'
import { FeedHandlers } from './handlers/feed'
import { GroupsHandlers } from './handlers/groups'
import { HistoryHandlers } from './handlers/history'
import { StorageHandlers } from './handlers/storage'

export const HandlersLive = Layer.mergeAll(CoreHandlers, GroupsHandlers, FeedHandlers, AccountHandlers, ExpensesHandlers, HistoryHandlers, StorageHandlers)
