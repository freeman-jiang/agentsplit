// Every area's RPC handlers, merged. Each area registers its handlers in src/server/handlers/.
import { Layer } from 'effect'
import { CoreHandlers } from './handlers/core'
import { HistoryHandlers } from './handlers/history'

export const HandlersLive = Layer.mergeAll(CoreHandlers, HistoryHandlers)
