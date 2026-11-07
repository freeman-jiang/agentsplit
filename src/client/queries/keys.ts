// Every query key, and the one rule for what a write makes stale. A group's
// keys all start with group(groupId), its ID and never its URL slug, so one
// invalidation reaches every view of that group.
import type { QueryClient } from '@tanstack/react-query'

export const keys = {
  me: ['me'],
  account: ['account'],
  consentClient: (clientId: string) => ['consent-client', clientId],
  reference: ['reference'],
  storageUsage: ['storage', 'usage'],
  ownReceipts: (order: string) => ['storage', 'receipts', order],
  directories: ['directory'],
  directory: (offset: number) => ['directory', offset],
  invitation: (token: string) => ['invitation', token],
  feed: ['feed'],
  feedList: (filter: object) => ['feed', 'list', filter],
  feedBalances: ['feed', 'balances'],
  feedOptions: ['feed', 'options'],
  /** An expense on the /expenses pages: the group or private context it belongs to. */
  expenseContexts: ['expense-context'],
  expenseContext: (expenseId: string) => ['expense-context', expenseId],
  group: (groupId: string) => ['group', groupId],
  groupSummary: (groupId: string) => ['group', groupId, 'summary'],
  groupDetails: (groupId: string) => ['group', groupId, 'details'],
  expenses: (groupId: string, filter: object) => ['group', groupId, 'expenses', filter],
  expense: (groupId: string, expenseId: string) => ['group', groupId, 'expense', expenseId],
  balances: (groupId: string) => ['group', groupId, 'balances'],
  activities: (groupId: string, filter: object) => ['group', groupId, 'activities', filter],
  stats: (groupId: string, scope: object) => ['group', groupId, 'stats', scope],
  statsExpenses: (groupId: string, scope: object) => ['group', groupId, 'stats-expenses', scope],
} as const

/**
 * `group`: a write in one group or private context (an expense, a payment, its
 * settings or people). `account`: a write that can change every group, such as
 * the display name or a receipt deleted for good.
 */
type WriteScope = { readonly scope: 'group'; readonly groupId: string } | { readonly scope: 'account' }

/**
 * After a write, every view it can change reads again: the group's own pages,
 * and the views across groups (the dashboard, the directory and the
 * /expenses pages). Only the views on screen fetch at once; the rest fetch
 * when they open.
 */
export function afterWrite(data: { queryClient: QueryClient } & WriteScope) {
  const { queryClient } = data
  if (data.scope === 'account') return queryClient.invalidateQueries()
  return Promise.all(
    [keys.group(data.groupId), keys.feed, keys.directories, keys.expenseContexts].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  )
}
