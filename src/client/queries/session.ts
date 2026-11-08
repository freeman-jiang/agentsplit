// The session: who is signed in, the guard of signed-in pages, and signing
// out. Route guards import this module and are not code-split, so it stays
// small: the Better Auth client is in src/client/auth-client.ts, which only
// screen components import.
import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { redirect } from '@tanstack/react-router'
import { SESSION_REFRESH_KEY } from '../../shared/account'
import { AUTH_PATH } from '../../shared/paths'
import { rpc } from '../rpc'
import { keys } from './keys'

/**
 * Who is signed in. The answer stays fresh for a minute, so the screens of one
 * visit that each show it read it once; a write to the account refreshes it
 * at once (afterWrite in keys.ts).
 */
export const meQuery = queryOptions({ queryKey: keys.me, queryFn: () => rpc((api) => api('session.me', undefined)), staleTime: 60_000 })

/** At most one refresh an hour. Better Auth moves the expiry at most once a day (updateAge), so a closer refresh changes nothing. */
const REFRESH_EVERY_MS = 60 * 60 * 1000

/**
 * Lets Better Auth move the session's expiry (get-session); RPC calls only
 * read the session. A page load sends it when the last one from this browser
 * is an hour old or more, or unknown.
 */
export function refreshSession() {
  const now = Date.now()
  try {
    const last = Number(localStorage.getItem(SESSION_REFRESH_KEY))
    if (last > 0 && last <= now && now - last < REFRESH_EVERY_MS) return
    localStorage.setItem(SESSION_REFRESH_KEY, String(now))
  } catch {
    // No storage (a private window, blocked site data): refresh on every load, as before.
  }
  void fetch(`${AUTH_PATH}/get-session`, { credentials: 'same-origin' }).catch((error: unknown) => console.error('Session refresh failed', error))
}

/** The sign-in page, returning to `next` (a same-origin path) afterwards. */
const signInHref = (next?: string) => (next ? `/sign-in?${new URLSearchParams({ next })}` : '/sign-in')

/**
 * Sends a signed-out visitor, or a session the server does not accept, to
 * /sign-in; they come back to the requested page as the address bar shows it
 * (P-AUTH-49, P-ACCESS-32).
 */
export async function requireSignedIn(data: { queryClient: QueryClient; location: { publicHref: string } }) {
  if (!(await data.queryClient.ensureQueryData(meQuery))) throw redirect({ href: signInHref(data.location.publicHref), replace: true })
}

/** Ends the session, then loads /sign-in in full, which drops every cached query of the account. */
export async function signOut(data: { next?: string } = {}) {
  const response = await fetch(`${AUTH_PATH}/sign-out`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'same-origin' })
  if (!response.ok) throw new Error('Could not sign out. Try again.')
  window.location.assign(signInHref(data.next))
}
