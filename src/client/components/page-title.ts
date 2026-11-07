import { useMatches } from '@tanstack/react-router'
import { useEffect } from 'react'
import type { FileRoutesById } from '~/client/routeTree.gen'

const DEFAULT_TITLE = 'AgentSplit · Shared expenses, simply settled'

/**
 * The title of every route, as in the current app (P-GROUP-48). `null` keeps
 * the parent's title. Group pages read "<title> · <group> · AgentSplit", and a
 * group's own root reads "<group> · AgentSplit". A new route fails the type
 * check until it is added here.
 */
const TITLES: Record<Exclude<keyof FileRoutesById, '__root__'>, string | null> = {
  '/': null,
  '/expenses': 'Expenses',
  '/expenses/create': 'Add expense',
  '/expenses/$expenseId/': 'Expense',
  '/expenses/$expenseId/payments/create': 'Record payment',
  '/agents': 'Set up your agent',
  '/privacy': 'Privacy',
  '/sign-in': 'Sign in',
  '/settings': null,
  '/settings/': 'Account & agent keys',
  '/settings/connections/': 'Connected apps',
  '/settings/connections/consent': 'Connect an app',
  '/invite/$token': 'Accept invitation',
  '/groups/': 'Recent groups',
  '/groups/create': 'Create group',
  '/$group': null,
  '/$group/': null,
  '/$group/expenses': 'Expenses',
  '/$group/expenses/': null,
  '/$group/expenses/create': 'Add expense',
  '/$group/expenses/$expenseId/edit': 'Edit expense',
  '/$group/payments': 'Payments',
  '/$group/payments/': null,
  '/$group/payments/create': 'Record payment',
  '/$group/payments/$expenseId/edit': 'Edit payment',
  '/$group/balances': 'Balances',
  '/$group/information': 'Information',
  '/$group/stats': 'Totals',
  '/$group/activity': 'Log',
  '/$group/edit': 'Settings',
}

const hasName = (value: unknown): value is { name: string } =>
  typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string'

/** Sets the document title from the deepest matched route. Used once, in the root layout. */
export function useDocumentTitle() {
  const title = useMatches({
    select: (matches) => {
      let page: string | null = null
      let group: string | null = null
      for (const match of matches) {
        if (match.routeId === '__root__') continue
        page = TITLES[match.routeId] ?? page
        if (match.routeId === '/$group' && hasName(match.loaderData)) group = match.loaderData.name
      }
      const parts = [page, group].filter((part): part is string => part !== null)
      return parts.length ? `${parts.join(' · ')} · AgentSplit` : DEFAULT_TITLE
    },
  })
  useEffect(() => {
    document.title = title
  }, [title])
}
