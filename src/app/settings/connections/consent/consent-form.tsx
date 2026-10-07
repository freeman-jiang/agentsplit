'use client'

import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/auth-client'
import { OAUTH_READ_SCOPE, OAUTH_WRITE_SCOPE } from '@/lib/oauth-config'
import { useState } from 'react'

export function ConsentForm({
  scopes,
  requestedClaims,
}: {
  scopes: string[]
  requestedClaims: string[]
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [allowWrite, setAllowWrite] = useState(
    scopes.includes(OAUTH_WRITE_SCOPE),
  )
  async function respond(accept: boolean) {
    setPending(true)
    setError('')
    try {
      const result = await authClient.oauth2.consent({
        accept,
        scope: scopes
          .filter((s) => allowWrite || s !== OAUTH_WRITE_SCOPE)
          .join(' '),
      })
      if (result.error || !result.data?.url)
        throw new Error(
          result.error?.message ?? 'Unable to authorize this connection',
        )
      // Better Auth already follows redirect=true responses. Avoid a second navigation.
      if (!result.data.redirect) window.location.assign(result.data.url)
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Unable to authorize this connection',
      )
      setPending(false)
    }
  }
  return (
    <div className="space-y-6">
      <div className="border bg-card p-5 space-y-4">
        <h2 className="font-medium">Requested access</h2>
        <ul className="list-disc space-y-3 ps-5 text-sm">
          {scopes.includes(OAUTH_READ_SCOPE) && (
            <li>
              Read your groups, people, expenses, payments, balances, receipts,
              exports and full revision history.
            </li>
          )}
          {scopes.includes('profile') && (
            <li>Read your account name and profile information.</li>
          )}
          {scopes.includes('email') && <li>Read your email address.</li>}
          {scopes.includes('openid') && (
            <li>Identify your AgentSplit account.</li>
          )}
          {scopes.includes('offline_access') && (
            <li>
              Stay connected using renewable tokens until you revoke access or
              the connection expires.
            </li>
          )}
        </ul>
        {requestedClaims.length > 0 && (
          <p className="break-words text-sm">
            Additional requested profile fields: {requestedClaims.join(', ')}.
          </p>
        )}
        {scopes.includes(OAUTH_WRITE_SCOPE) && (
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={allowWrite}
              onChange={(e) => setAllowWrite(e.target.checked)}
            />
            <span>
              Allow changes: create and edit groups, expenses and payments;
              delete expenses; and manage invitations and members where you are
              an admin.
            </span>
          </label>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Access follows your current group memberships and roles, including
        groups you join later. Your Google password and Google tokens are never
        shared with this app. Revoke access at any time in Account settings.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <Button disabled={pending} onClick={() => respond(true)}>
          {pending ? 'Continuing…' : 'Allow access'}
        </Button>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => respond(false)}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
