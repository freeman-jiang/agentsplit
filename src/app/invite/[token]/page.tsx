import { createHash } from 'node:crypto'
import { getAuth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { requireWebUser } from '@/lib/session'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { AcceptInvitation } from './accept-invitation'

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
    include: { group: { select: { name: true } } },
  })
  const valid =
    invitation &&
    !invitation.revokedAt &&
    invitation.expiresAt > new Date() &&
    invitation.email === user.email.toLowerCase() &&
    invitation.participantId

  return (
    <main className="mx-auto max-w-lg w-full px-4 py-16 space-y-6">
      <h1 className="font-display text-4xl">Join a private group</h1>
      <p>
        This invitation can only be accepted by the Google account it was
        addressed to.
      </p>
      <p className="text-sm text-muted-foreground">Signed in as {user.email}</p>
      {valid ? (
        <>
          <p>
            Join <strong>{invitation.group.name}</strong> as{' '}
            <strong>{invitation.participantName}</strong>. This is your fixed
            participant identity.
          </p>
          <AcceptInvitation token={token} />
        </>
      ) : (
        <p role="alert">
          This invitation is unavailable for this account, expired, or needs to
          be reissued with a participant identity. Ask the group admin for a new
          invitation.
        </p>
      )}
    </main>
  )
}
