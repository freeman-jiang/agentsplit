import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { meQuery } from '~/client/queries'
import { errorMessage, invitationQuery, newIdempotencyKey, refreshGroups } from '~/client/queries/groups'
import { rpc } from '~/client/rpc'
import { Alert, AlertDescription } from '~/client/ui/alert'
import { Button } from '~/client/ui/button'
import { INVITATION_TOKEN } from '~/shared/groups'

const signInFor = (token: string) => `/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`

export const Route = createFileRoute('/invite/$token')({
  beforeLoad: async ({ context, params }) => {
    if (!INVITATION_TOKEN.test(params.token)) throw redirect({ to: '/groups', replace: true })
    // Signed out, or a session the server does not accept: sign in, then come back here (P-ACCESS-32, P-ACCESS-33).
    if (!(await context.queryClient.ensureQueryData(meQuery))) throw redirect({ href: signInFor(params.token), replace: true })
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
      <p>This invitation is for one Google account. Check that you’re signed in with the email your friend invited.</p>
      <p className="text-sm text-muted-foreground">Signed in as {me?.email}</p>
      {valid ? (
        <>
          <p>
            {personal ? 'View' : 'Join'} <strong>{valid.groupName}</strong> as <strong>{valid.participantName}</strong>. Existing expenses and balances under this name
            will be linked to your account.
          </p>
          <AcceptInvitation token={token} />
          <div className="space-y-3 border-t pt-5 text-sm">
            <h2 className="font-medium">What happens next?</h2>
            <p>
              {personal
                ? 'You’ll go to this private expense. You can review the split, record repayments and see who owes whom.'
                : 'You’ll go straight to the group. You can review expenses, add your own, record payments and see who owes whom.'}
            </p>
            <p>
              Want ChatGPT or Claude to help? After joining, open <strong>Agents</strong> in the navigation and follow the setup steps. Or just keep using the
              browser—an agent is optional.
            </p>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <Alert>
            <AlertDescription>
              This invitation is unavailable for this account. It may be addressed to another Google email, expired, revoked, or need reissuing.
            </AlertDescription>
          </Alert>
          <p className="text-sm">Try the Google account your friend invited. If you’re already using that account, ask them for a fresh invitation link.</p>
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
            const shareUrl = new URL(`/invite/${token}`, window.location.origin).href
            const result = await rpc((api) => api('groups.access', { idempotencyKey, request: { action: 'join', shareUrl } }))
            await refreshGroups(queryClient)
            await navigate({ to: '/$group', params: { group: result.groupId } })
          } catch (e) {
            setError(errorMessage(e))
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
            const response = await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
            if (!response.ok) throw new Error('Sign-out failed')
            // A full page load drops every cached query of the old account.
            window.location.assign(signInFor(token))
          } catch {
            setPending(false)
            setError('Unable to sign out. Please try again.')
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
