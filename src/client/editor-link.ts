import type { ExpenseKind } from '~/shared/vocabulary'

/**
 * The editor of an entry on a group's pages, for <Link> or navigate(): a
 * payment opens the payment editor (P-HIST-70). `group` is the URL segment.
 */
export const editorLink = (data: { group: string; expenseId: string; kind: ExpenseKind }) =>
  data.kind === 'payment'
    ? ({ to: '/$group/payments/$expenseId/edit', params: { group: data.group, expenseId: data.expenseId } } as const)
    : ({ to: '/$group/expenses/$expenseId/edit', params: { group: data.group, expenseId: data.expenseId } } as const)
