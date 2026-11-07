// The typed contract between the SPA and the server: every area's procedures,
// merged into one group. Each area defines its procedures in a file beside this one.
// MCP tools call the same domain services, so these schemas also describe agent writes.
import { AccountApi } from './account'
import { CoreApi } from './core'
import { ExpensesApi } from './expenses'
import { FeedApi } from './feed'
import { GroupsApi } from './groups'
import { HistoryApi } from './history'
import { StorageApi } from './storage'

export * from './account'
export * from './core'
export * from './expenses'
export * from './feed'
export * from './groups'
export * from './history'
export * from './storage'

export class AgentSplitApi extends CoreApi.merge(GroupsApi, FeedApi, AccountApi, ExpensesApi, HistoryApi, StorageApi) {}
