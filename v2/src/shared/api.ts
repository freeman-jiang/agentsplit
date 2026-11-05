// The typed contract between the SPA and the Worker: every area's procedures,
// merged into one group. Each area defines its procedures in src/shared/api/.
// MCP tools call the same domain services, so these schemas also describe agent writes.
import { CoreApi } from './api/core'
import { HistoryApi } from './api/history'

export * from './api/core'
export * from './api/history'

export class AgentSplitApi extends CoreApi.merge(HistoryApi) {}
