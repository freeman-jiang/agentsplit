import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { meQuery, requireSignedIn, signOut } from '~/client/queries/session'
import { describeError } from '~/client/errors'
import { invitationQuery } from '~/client/queries/groups'
import { afterWrite } from '~/client/queries/keys'
import { newIdempotencyKey, rpc } from '~/client/rpc'
import { Alert, AlertDescription } from '~/client/ui/alert'
import { Button } from '~/client/ui/button'
import { SECRET_TOKEN } from '~/shared/ids'
import { invitationPath } from '~/shared/paths'

export const Route = createFileRoute('/invite/$token')({
  beforeLoad: async ({ context, params, location }) => {
    if (!SECRET_TOKEN.test(params.token)) throw redirect({ to: '/groups', replace: true })
    // Signed out, or a session the server does not accept: sign in, then come back here (P-ACCESS-32, P-ACCESS-33).
    await requireSignedIn({ queryClient: context.queryClient, location })
  },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(invitationQuery(params.token)),
  component: InvitationPage,
})

function InvitationPage() {
  const { token } = Route.useParams()
  const { data: me } = useSuspenseQuery(meQuery)
  const { data: invitation } = useSuspenseQuery(invitationQuery(token))
  const valid = invitation.status === 'valid' ? invitation : null
  const personal = valid?.kind === 'private'
  return (
    <main className="mx-auto w-full max-w-lg space-y-6 px-4 py-16">
      <h1 className="font-display text-4xl">{personal ? 'View a private expense' : 'Accept invitation'}</h1>
      <p>This invitation is for one Google account. Make sure you are signed in with that account.</p>
      <p className="text-sm text-muted-foreground">Signed in as {me?.email}</p>
      {valid ? (
        <>
          <p>
            {personal ? 'View' : 'Join'} <strong>{valid.groupName}</strong> as <strong>{valid.participantName}</strong>. The expenses and balances under this name
            are linked to your account.
          </p>
          <AcceptInvitation token={token} />
          <div className="space-y-3 border-t pt-5 text-sm">
            <h2 className="font-medium">Next</h2>
            <p>
              {personal
                ? 'You go to the expense. There you can check the split, record payments and see who owes whom.'
                : 'You go to the group. There you can see expenses, add your own, record payments and see who owes whom.'}
            </p>
            <p>
              To use ChatGPT or Claude, open <strong>Agents</strong> after you join. An agent is optional.
            </p>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <Alert>
            <AlertDescription>
              You cannot use this invitation with this account. It is for another Google email, or it expired, or an admin revoked it.
            </AlertDescription>
          </Alert>
          <p className="text-sm">Sign in with the invited Google account. If you already use that account, ask for a new invitation link.</p>
        </div>
      )}
      <SwitchAccount token={token} />
    </main>
  )
}

function AcceptInvitation({ token }: { token: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [idempotencyKey] = useState(newIdempotencyKey)
  return (
    <div className="space-y-4">
      <Button
        disabled={pending}
        onClick={async () => {
          setPending(true)
          setError(null)
          try {
            const shareUrl = new URL(invitationPath(token), window.location.origin).href
            const result = await rpc((api) => api('groups.access', { idempotencyKey, request: { action: 'join', shareUrl } }))
            await afterWrite({ queryClient, scope: 'group', groupId: result.groupId })
            await navigate({ to: '/$group', params: { group: result.groupId } })
          } catch (e) {
            setError(describeError(e).message)
            setPending(false)
          }
        }}
      >
        {pending ? 'Joining…' : 'Accept invitation'}
      </Button>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

function SwitchAccount({ token }: { token: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className="space-y-3">
      <Button
        variant="outline"
        disabled={pending}
        onClick={async () => {
          setPending(true)
          setError('')
          try {
            await signOut({ next: invitationPath(token) })
          } catch (cause) {
            setPending(false)
            setError(describeError(cause).message)
          }
        }}
      >
        {pending ? 'Signing out…' : 'Use a different Google account'}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
