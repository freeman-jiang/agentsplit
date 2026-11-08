// The MCP server's public names: its path, the API-key header and the tool
// names. The server registers its tools under these names, and the Agents page
// quotes them in its setup steps. No Effect import: the client uses this module.

/** The MCP endpoint, on the app's origin. */
export const MCP_PATH = '/api/mcp'

/** The header that carries an API key, as clients write it. HTTP header names are case-insensitive. */
export const API_KEY_HEADER = 'X-API-Key'

/** Every tool, in the order tools/list gives them (src/server/mcp/tools/index.ts, MCP.md). */
export const MCP_TOOL_NAMES = [
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
  'get_storage_usage',
  'list_receipts',
  'delete_receipts',
] as const
export type McpToolName = (typeof MCP_TOOL_NAMES)[number]
