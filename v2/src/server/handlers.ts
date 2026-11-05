// Every area's RPC handlers, merged. Each area registers its handlers in src/server/handlers/.
import { Layer } from 'effect'
import { AccountHandlers } from './handlers/account'
import { CoreHandlers } from './handlers/core'

export const HandlersLive = Layer.mergeAll(CoreHandlers, AccountHandlers)
