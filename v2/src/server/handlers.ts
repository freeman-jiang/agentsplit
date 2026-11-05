// Every area's RPC handlers, merged. Each area registers its handlers in src/server/handlers/.
import { Layer } from 'effect'
import { CoreHandlers } from './handlers/core'
import { ExpensesHandlers } from './handlers/expenses'

export const HandlersLive = Layer.mergeAll(CoreHandlers, ExpensesHandlers)
