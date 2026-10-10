import { createHash } from 'node:crypto'
import { getAuth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { requireWebUser } from '@/lib/session'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { AcceptInvitation, SwitchInvitationAccount } from './accept-invitation'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Accept invitation' }
export default async function InvitationPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) redirect('/groups')
  const session = await getAuth().api.getSession({ headers: await headers() })
  if (!session)
    redirect(`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`)
  const user = await requireWebUser()
  const invitation = await prisma.groupInvitation.findUnique({
    where: { tokenHash: createHash('sha256').update(token).digest('hex') },
    include: {
      group: {
        select: {
          name: true,
          ungroupedContext: { select: { expenseId: true } },
        },
      },
    },
  })
  const valid =
    invitation &&
    !invitation.revokedAt &&
    invitation.expiresAt > new Date() &&
    invitation.email === user.email.toLowerCase() &&
    invitation.participantId

  return (
    <main className="mx-auto max-w-lg w-full px-4 py-16 space-y-6">
      <h1 className="font-display text-4xl">
        {valid && invitation.group.ungroupedContext
          ? 'View a private expense'
          : 'Accept invitation'}
      </h1>
      <p>
        This invitation is for one Google account. Check that you’re signed in
        with the email your friend invited.
      </p>
      <p className="text-sm text-muted-foreground">Signed in as {user.email}</p>
      {valid ? (
        <>
          <p>
            {invitation.group.ungroupedContext ? 'View' : 'Join'}{' '}
            <strong>{invitation.group.name}</strong> as{' '}
            <strong>{invitation.participantName}</strong>. Existing expenses and
            balances under this name will be linked to your account.
          </p>
          <AcceptInvitation token={token} />
          <div className="border-t pt-5 space-y-3 text-sm">
            <h2 className="font-medium">What happens next?</h2>
            <p>
              {invitation.group.ungroupedContext
                ? 'You’ll go to this private expense. You can review the split, record repayments and see who owes whom.'
                : 'You’ll go straight to the group. You can review expenses, add your own, record payments and see who owes whom.'}
            </p>
            <p>
              Want ChatGPT or Claude to help? After joining, open{' '}
              <strong>Agents</strong> in the navigation and follow the setup
              steps. Or just keep using the browser—an agent is optional.
            </p>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <p role="alert">
            This invitation is unavailable for this account. It may be addressed
            to another Google email, expired, revoked, or need reissuing.
          </p>
          <p className="text-sm">
            Try the Google account your friend invited. If you’re already using
            that account, ask them for a fresh invitation link.
          </p>
        </div>
      )}
      <SwitchInvitationAccount token={token} />
    </main>
  )
}
