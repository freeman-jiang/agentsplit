import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { DeleteDialog } from '~/client/components/delete-dialog'
import { accountQuery } from '~/client/queries/account'
import { afterWrite } from '~/client/queries/keys'
import { rpc } from '~/client/rpc'
import { Button } from '~/client/ui/button'

export const Route = createFileRoute('/settings/connections/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(accountQuery),
  component: Connections,
})

function Connections() {
  const { data: account } = useSuspenseQuery(accountQuery)
  const queryClient = useQueryClient()
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
                <DeleteDialog
                  trigger={
                    <Button size="sm" variant="outline">
                      Revoke access
                    </Button>
                  }
                  title="Revoke this app’s access?"
                  description="To use it again, connect it again."
                  confirm="Revoke access"
                  pending="Revoking…"
                  onConfirm={async () => {
                    await rpc((api) => api('account.revokeConnection', { clientId: c.clientId }))
                    await afterWrite({ queryClient, scope: 'account' })
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}
