// Every MCP tool, in the order tools/list advertises them: the current app's
// order (src/lib/mcp/registry.ts), then the v2 storage tools. The order and
// names are MCP_TOOL_NAMES in src/shared/mcp.ts; MCP.md's tool table follows
// this list (test/docs.test.ts).
import { MCP_TOOL_NAMES, type McpToolName } from '../../../shared/mcp'
import type { McpTool } from './registry'
import { updateProfile } from './account'
import { getBalances, getParticipantBalances, processRecurringExpenses } from './balances'
import { createExpense, deleteExpense, getExpense, listExpenses, updateExpense } from './expenses'
import { getExpenseOptions, listAllExpenses } from './feed'
import { createGroup, getGroup, listGroups, manageGroupAccess, updateGroup } from './groups'
import { exportGroup, getSpendingStats, listActivity } from './history'
import { getReferenceData } from './reference'
import { deleteReceipts, getStorageUsage, listReceipts } from './storage'

/** Each tool under its own name: the type checker refuses a missing tool or a tool under another name. */
const TOOLS: { readonly [N in McpToolName]: McpTool & { readonly name: N } } = {
  list_all_expenses: listAllExpenses,
  get_expense_options: getExpenseOptions,
  update_profile: updateProfile,
  list_groups: listGroups,
  get_group: getGroup,
  create_group: createGroup,
  update_group: updateGroup,
  manage_group_access: manageGroupAccess,
  list_expenses: listExpenses,
  get_expense: getExpense,
  create_expense: createExpense,
  update_expense: updateExpense,
  delete_expense: deleteExpense,
  get_balances: getBalances,
  get_participant_balances: getParticipantBalances,
  get_spending_stats: getSpendingStats,
  list_activity: listActivity,
  process_recurring_expenses: processRecurringExpenses,
  get_reference_data: getReferenceData,
  export_group: exportGroup,
  get_storage_usage: getStorageUsage,
  list_receipts: listReceipts,
  delete_receipts: deleteReceipts,
}

export const MCP_TOOLS: readonly McpTool[] = MCP_TOOL_NAMES.map((name) => TOOLS[name])
