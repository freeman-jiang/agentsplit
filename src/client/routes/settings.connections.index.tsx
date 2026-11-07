import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { accountQuery } from '~/client/queries/account'
import { rpc } from '~/client/rpc'
import { Button } from '~/client/ui/button'

export const Route = createFileRoute('/settings/connections/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(accountQuery),
  component: Connections,
})

function Connections() {
  const { data: account } = useSuspenseQuery(accountQuery)
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  async function revoke(clientId: string) {
    if (!window.confirm('Revoke this app’s access to AgentSplit? It must connect again to regain access.')) return
    setPending(clientId)
    setError('')
    try {
      await rpc((api) => api('account.revokeConnection', { clientId }))
      await queryClient.invalidateQueries({ queryKey: accountQuery.queryKey })
    } catch {
      setError('Could not revoke the connection. Please try again.')
    } finally {
      setPending(null)
    }
  }
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-8">
      <Link className="text-sm underline" to="/settings">
        Account settings
      </Link>
      <h1 className="font-display text-3xl">Connected apps</h1>
      <p className="text-sm text-muted-foreground">
        Apps authorized through sign-in, such as ChatGPT. Revoking one stops its access and refresh tokens immediately. Your API keys
        are managed separately.
      </p>
      <div className="space-y-4">
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {account.connections.length === 0 ? (
          <p>No connected apps yet.</p>
        ) : (
          <ul className="divide-y rounded-2xl border bg-card px-5">
            {account.connections.map((c) => (
              <li key={c.clientId} className="flex flex-wrap items-center justify-between gap-4 py-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{c.name}</p>
                  <p className="break-all text-xs text-muted-foreground">{c.clientId}</p>
                  <p className="mt-1 text-sm">{c.canWrite ? 'Read and manage your groups' : 'Read only'}</p>
                </div>
                <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void revoke(c.clientId)}>
                  {pending === c.clientId ? 'Revoking…' : 'Revoke access'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}
