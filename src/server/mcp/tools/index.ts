// Every MCP tool, in the order tools/list advertises them: the current app's
// order (src/lib/mcp/registry.ts), then the v2 storage tools. MCP.md's tool
// table follows this list (test/mcp-docs.test.ts).
import type { McpTool } from '../registry'
import { updateProfile } from './account'
import { getBalances, getParticipantBalances, processRecurringExpenses } from './balances'
import { createExpense, deleteExpense, getExpense, listExpenses, updateExpense } from './expenses'
import { getExpenseOptions, listAllExpenses } from './feed'
import { createGroup, getGroup, listGroups, manageGroupAccess, updateGroup } from './groups'
import { exportGroup, getSpendingStats, listActivity } from './history'
import { getReferenceData } from './reference'
import { deleteReceipts, getStorageUsage, listReceipts } from './storage'

export const MCP_TOOLS: readonly McpTool[] = [
  listAllExpenses,
  getExpenseOptions,
  updateProfile,
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
  manageGroupAccess,
  listExpenses,
  getExpense,
  createExpense,
  updateExpense,
  deleteExpense,
  getBalances,
  getParticipantBalances,
  getSpendingStats,
  listActivity,
  processRecurringExpenses,
  getReferenceData,
  exportGroup,
  getStorageUsage,
  listReceipts,
  deleteReceipts,
]
