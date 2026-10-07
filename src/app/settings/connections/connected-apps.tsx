'use client'

import { Button } from '@/components/ui/button'
import { OAUTH_WRITE_SCOPE } from '@/lib/oauth-config'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function ConnectedApps({
  connections,
}: {
  connections: { clientId: string; name: string; scopes: string[] }[]
}) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null),
    [error, setError] = useState('')
  async function revoke(clientId: string) {
    if (
      !window.confirm(
        'Revoke this app’s access to AgentSplit? It must connect again to regain access.',
      )
    )
      return
    setPending(clientId)
    setError('')
    try {
      const r = await fetch('/api/connections/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }),
      })
      if (!r.ok)
        throw new Error('Could not revoke the connection. Please try again.')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not revoke connection')
    } finally {
      setPending(null)
    }
  }
  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {connections.length === 0 ? (
        <p>No connected apps yet.</p>
      ) : (
        <ul className="divide-y border bg-card px-5">
          {connections.map((c) => (
            <li
              key={c.clientId}
              className="flex flex-wrap items-center justify-between gap-4 py-4"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">{c.name}</p>
                <p className="break-all text-xs text-muted-foreground">
                  {c.clientId}
                </p>
                <p className="mt-1 text-sm">
                  {c.scopes.includes(OAUTH_WRITE_SCOPE)
                    ? 'Read and manage your groups'
                    : 'Read only'}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={() => revoke(c.clientId)}
              >
                {pending === c.clientId ? 'Revoking…' : 'Revoke access'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
