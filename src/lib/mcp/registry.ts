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

/** The sole catalog of MCP tools. Mutations cannot be mapped by this registry. */
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
      'Read a page of saved expenses. Amounts are integer currency minor units, not whole dollars. Follow nextCursor while hasMore is true. This read does not generate recurring expenses.',
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
      'Read the existing group activity feed. Request pages using nextCursor until hasMore is false for the full feed. Events contain activity summaries, not immutable before/after snapshots.',
    procedure: 'groups.activities.list',
  },
  {
    name: 'list_categories',
    description: 'Read the category IDs and names used by expense records.',
    procedure: 'categories.list',
  },
] as const satisfies readonly ToolDefinition[]
