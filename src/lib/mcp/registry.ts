import type { AppRouter } from '@/trpc/routers/_app'
import type { AnyTRPCQueryProcedure, TRPCRouterRecord } from '@trpc/server'

type QueryPaths<T extends TRPCRouterRecord> = {
  [K in keyof T & string]: T[K] extends AnyTRPCQueryProcedure
    ? K
    : T[K] extends TRPCRouterRecord
      ? `${K}.${QueryPaths<T[K]>}`
      : never
}[keyof T & string]

export type ReadProcedurePath = QueryPaths<AppRouter['_def']['record']>

type ToolDefinition = {
  name: string
  description: string
  procedure: ReadProcedurePath
}

/**
 * Prefer broad, composable tools over one tool per UI view or special case.
 * This reviewed catalog admits queries only; not every query needs an MCP tool.
 */
export const MCP_TOOL_REGISTRY = [
  {
    name: 'list_groups',
    description:
      "List the authenticated user's expense groups. Omit groupIds to list all your groups, or supply a subset. Follow nextCursor while hasMore is true. Keys inherit user access; this never scans unrelated groups.",
    procedure: 'groups.list',
  },
  {
    name: 'get_group',
    description:
      'Read a group, its currency, and participant IDs. Use these IDs for subsequent expense and balance reads.',
    procedure: 'groups.get',
  },
  {
    name: 'list_expenses',
    description:
      'Read saved expenses across all time, or filter by inclusive from/to expense dates (YYYY-MM-DD) and case-insensitive title filter. For a month, use its first and last dates. Results include reimbursements and are newest first. Request up to 100 per page and follow nextCursor while hasMore is true, keeping the same filters. Amounts are integer currency minor units. This read does not generate recurring expenses.',
    procedure: 'groups.expenses.list',
  },
  {
    name: 'get_expense',
    description:
      'Read a saved expense and its receipt URLs. Both expense ID and owning group ID are required. Amounts are integer currency minor units.',
    procedure: 'groups.expenses.get',
  },
  {
    name: 'get_balances',
    description:
      'Read current balances and suggested reimbursements from saved expenses. Amounts are integer currency minor units. This read does not generate recurring expenses.',
    procedure: 'groups.balances.list',
  },
  {
    name: 'list_activity',
    description:
      'Read append-only group history, including full expense revision snapshots and deletion markers. Filter by expenseId, activityType, or inclusive from/to UTC event dates (YYYY-MM-DD). Page with nextCursor until hasMore is false. Legacy events lack snapshots; source=baseline starts preserved history for older expenses. Actor names from web edits are unverified labels. Receipts are URL references.',
    procedure: 'groups.activities.list',
  },
  {
    name: 'list_categories',
    description: 'Read the category IDs and names used by expense records.',
    procedure: 'categories.list',
  },
  {
    name: 'get_group_details',
    description:
      'Read group details and the participant IDs referenced by saved expenses. Participant IDs describe bookkeeping people, not the authenticated agent identity.',
    procedure: 'groups.getDetails',
  },
  {
    name: 'get_participant_balances',
    description:
      'Read net balances for selected group/participant pairs across your groups. Discover participant IDs with get_group. Each amount is in that group currency minor units; do not add different currencies together. This does not establish participant identity or generate recurring expenses.',
    procedure: 'groups.balances.forUser',
  },
  {
    name: 'get_spending_stats',
    description:
      'Read group spending summaries by month, category, and participant, plus estimates for saved recurring expenses. Optional from/to dates use YYYY-MM-DD; participantId selects bookkeeping totals. Amounts use currency minor units. No recurring expenses are generated.',
    procedure: 'groups.stats.overview',
  },
  {
    name: 'list_category_expenses',
    description:
      'Read saved expenses contributing to category spending, excluding reimbursements. Use category IDs from list_categories. Optional from/to dates use YYYY-MM-DD. Amounts use currency minor units. No recurring expenses are generated.',
    procedure: 'groups.stats.categoryExpenses',
  },
] as const satisfies readonly ToolDefinition[]
