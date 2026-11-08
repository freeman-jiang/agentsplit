// The session: who is signed in, the guard of signed-in pages, and signing
// out. Route guards import this module and are not code-split, so it stays
// small: the Better Auth client is in src/client/auth-client.ts, which only
// screen components import.
import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { redirect } from '@tanstack/react-router'
import { AUTH_PATH } from '../../shared/paths'
import { rpc } from '../rpc'
import { keys } from './keys'

export const meQuery = queryOptions({ queryKey: keys.me, queryFn: () => rpc((api) => api('session.me', undefined)) })

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
  if (!response.ok) throw new Error('Unable to sign out. Please try again.')
  window.location.assign(signInHref(data.next))
}
