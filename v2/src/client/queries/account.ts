// The account area's queries and helpers. Route guards import this module and
// are not code-split, so it must stay small: the Better Auth client is in
// src/client/auth-client.ts, which only screen components import.
import { queryOptions } from '@tanstack/react-query'
import { redirect, type ParsedLocation } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { meQuery } from '../queries'
import { rpc } from '../rpc'

export const accountQuery = queryOptions({ queryKey: ['account'], queryFn: () => rpc((api) => api('account.get', undefined)) })

export const consentClientQuery = (clientId: string) =>
  queryOptions({ queryKey: ['consent-client', clientId], queryFn: () => rpc((api) => api('account.consentClient', { clientId })) })

/** Sends a signed-out visitor to /sign-in, keeping the requested page as the address bar shows it. */
export async function requireSignedIn(data: { queryClient: QueryClient; location: ParsedLocation }) {
  if (!(await data.queryClient.ensureQueryData(meQuery))) throw redirect({ to: '/sign-in', search: { next: data.location.publicHref } })
}

export type Theme = 'system' | 'light' | 'dark'
export const THEME_KEY = 'theme'

export function readTheme(): Theme {
  const value = localStorage.getItem(THEME_KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}

/** Saves the theme and applies it at once; public/theme.js applies it on the next load. */
export function saveTheme(theme: Theme) {
  localStorage.setItem(THEME_KEY, theme)
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

/** The message of a failed RPC or Better Auth call. */
export function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' && error.message)
    return error.message
  return fallback
}
