import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { authClient } from '~/client/auth-client'
import { describeError } from '~/client/errors'
import { consentClientQuery, meQuery } from '~/client/queries/account'
import { Button } from '~/client/ui/button'
import { OAUTH_READ_SCOPE, OAUTH_WRITE_SCOPE } from '~/shared/account'

export const Route = createFileRoute('/settings/connections/consent')({
  component: Consent,
})

type Request = { clientId: string; redirectHost: string; scopes: string[]; claims: string[] }

/** The claim names of the OIDC claims request, to list them; Better Auth checks the request itself. */
function requestedClaims(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}')
    if (typeof parsed !== 'object' || parsed === null) return []
    const sections = Object.entries(parsed).filter(([section]) => section === 'userinfo' || section === 'id_token')
    return [...new Set(sections.flatMap(([, value]) => (typeof value === 'object' && value !== null ? Object.keys(value) : [])))]
  } catch {
    return []
  }
}

/**
 * What the screen shows of the signed authorization query that Better Auth
 * sent here. Better Auth verifies the query when the user answers, so this
 * only reads it; without a client or scopes there is nothing to show.
 */
function parseRequest(search: string): Request | null {
  const query = new URLSearchParams(search)
  const clientId = query.get('client_id') ?? ''
  const scopes = (query.get('scope') ?? '').split(' ').filter(Boolean)
  if (!clientId || !scopes.length) return null
  const redirect = query.get('redirect_uri') ?? ''
  const redirectHost = URL.canParse(redirect) ? new URL(redirect).host || redirect : redirect
  return { clientId, redirectHost, scopes, claims: requestedClaims(query.get('claims')) }
}

function Consent() {
  const [request] = useState(() => parseRequest(window.location.search))
  const client = useQuery({ ...consentClientQuery(request?.clientId ?? ''), enabled: request !== null })
  if (request && client.isPending) return <main className="mx-auto max-w-lg px-4 py-12" aria-busy="true" />
  if (!request || !client.data) return <StartAgain />
  return <ConsentScreen request={request} clientName={client.data.name} />
}

function StartAgain() {
  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <h1 className="break-words font-display text-3xl">Start the connection again</h1>
      <p className="mt-4">This authorization request is incomplete or unsupported. Return to the app you are connecting and try again.</p>
    </main>
  )
}

function ConsentScreen(props: { request: Request; clientName: string | null }) {
  const { data: me } = useSuspenseQuery(meQuery)
  const { scopes, claims } = props.request
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [allowWrite, setAllowWrite] = useState(scopes.includes(OAUTH_WRITE_SCOPE))
  async function respond(accept: boolean) {
    setPending(true)
    setError('')
    try {
      // The OAuth provider client plugin adds this page's signed query as oauth_query.
      const result = await authClient.$fetch<{ redirect: boolean; url: string }>('/oauth2/consent', {
        method: 'POST',
        body: { accept, scope: scopes.filter((s) => allowWrite || s !== OAUTH_WRITE_SCOPE).join(' ') },
      })
      if (result.error || !result.data?.url) throw new Error(describeError(result.error, 'Unable to authorize this connection').message)
      // Better Auth's client already follows redirect=true responses. Avoid a second navigation.
      if (!result.data.redirect) window.location.assign(result.data.url)
    } catch (cause) {
      setError(describeError(cause, 'Unable to authorize this connection').message)
      setPending(false)
    }
  }
  return (
    <main className="mx-auto max-w-lg space-y-6 px-4 py-12">
      <h1 className="break-words font-display text-3xl">Connect {props.clientName ?? 'this app'} to AgentSplit</h1>
      <p className="text-sm text-muted-foreground">Signed in as {me?.email}</p>
      <p className="break-all text-xs text-muted-foreground">Client identity: {props.request.clientId}</p>
      <p className="break-all text-sm">Returns to: {props.request.redirectHost}</p>
      <p className="text-xs text-muted-foreground">
        The app supplies its name. Only approve if you started this connection and recognize the destination. For a localhost
        destination, this is an app running on your computer.
      </p>
      <div className="space-y-6">
        <div className="space-y-4 rounded-2xl border bg-card p-5">
          <h2 className="font-medium">Requested access</h2>
          <ul className="list-disc space-y-3 ps-5 text-sm">
            {scopes.includes(OAUTH_READ_SCOPE) && (
              <li>Read your groups, people, expenses, payments, balances, receipts, exports and full revision history.</li>
            )}
            {scopes.includes('profile') && <li>Read your account name and profile information.</li>}
            {scopes.includes('email') && <li>Read your email address.</li>}
            {scopes.includes('openid') && <li>Identify your AgentSplit account.</li>}
            {scopes.includes('offline_access') && (
              <li>Stay connected using renewable tokens until you revoke access or the connection expires.</li>
            )}
          </ul>
          {claims.length > 0 && <p className="break-words text-sm">Additional requested profile fields: {claims.join(', ')}.</p>}
          {scopes.includes(OAUTH_WRITE_SCOPE) && (
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1" checked={allowWrite} onChange={(event) => setAllowWrite(event.target.checked)} />
              <span>
                Allow changes: create and edit groups, expenses and payments; delete expenses; and manage invitations and members where
                you are an admin.
              </span>
            </label>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Access follows your current group memberships and roles, including groups you join later. Your Google password and Google
          tokens are never shared with this app. Revoke access at any time in Account settings.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-3">
          <Button disabled={pending} onClick={() => void respond(true)}>
            {pending ? 'Continuing…' : 'Allow access'}
          </Button>
          <Button variant="outline" disabled={pending} onClick={() => void respond(false)}>
            Cancel
          </Button>
        </div>
      </div>
    </main>
  )
}
