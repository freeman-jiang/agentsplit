// Every MCP tool, in the order tools/list advertises them: the current app's
// order (src/lib/mcp/registry.ts). Each area keeps its tools in its own file
// next to this one.
import type { McpTool } from '../registry'
import { accountTools } from './account'
import { balanceTools } from './balances'
import { expenseTools } from './expenses'
import { feedTools } from './feed'
import { groupTools } from './groups'
import { historyTools } from './history'
import { referenceTools } from './reference'

const ALL = [...feedTools, ...accountTools, ...groupTools, ...expenseTools, ...balanceTools, ...historyTools, ...referenceTools]

const ORDER = [
  'list_all_expenses',
  'get_expense_options',
  'update_profile',
  'list_groups',
  'get_group',
  'create_group',
  'update_group',
  'manage_group_access',
  'list_expenses',
  'get_expense',
  'create_expense',
  'update_expense',
  'delete_expense',
  'get_balances',
  'get_participant_balances',
  'get_spending_stats',
  'list_activity',
  'process_recurring_expenses',
  'get_reference_data',
  'export_group',
] as const

export const MCP_TOOLS: readonly McpTool[] = ORDER.map((name) => {
  const tool = ALL.find((t) => t.name === name)
  if (!tool) throw new Error(`MCP tool ${name} is not defined`)
  return tool
})
if (MCP_TOOLS.length !== ALL.length) throw new Error('Every defined MCP tool must have a place in ORDER')
