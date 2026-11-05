// The typed contract between the SPA and the Worker: every area's procedures,
// merged into one group. Each area defines its procedures in src/shared/api/.
// MCP tools call the same domain services, so these schemas also describe agent writes.
import { AccountApi } from './api/account'
import { CoreApi } from './api/core'

export * from './api/account'
export * from './api/core'

export class AgentSplitApi extends CoreApi.merge(AccountApi) {}
