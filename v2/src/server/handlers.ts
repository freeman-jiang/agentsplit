// Every area's RPC handlers, merged. Each area registers its handlers in src/server/handlers/.
import { Layer } from 'effect'
import { CoreHandlers } from './handlers/core'
import { GroupsHandlers } from './handlers/groups'

export const HandlersLive = Layer.mergeAll(CoreHandlers, GroupsHandlers)
