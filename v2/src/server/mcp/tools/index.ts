// Every MCP tool, in the order tools/list advertises them. Each area adds its
// list here with one line; its tools live in their own file next to this one.
import type { McpTool } from '../registry'
import { expenseTools } from './expenses'
import { groupTools } from './groups'

export const MCP_TOOLS: readonly McpTool[] = [...groupTools, ...expenseTools]
