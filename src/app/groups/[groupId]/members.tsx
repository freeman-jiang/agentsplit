'use client'

import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { trpc } from '@/trpc/client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function GroupMembers({ groupId }: { groupId: string }) {
  const router = useRouter(),
    utils = trpc.useUtils()
  const { data } = trpc.groups.getDetails.useQuery({ groupId })
  const [email, setEmail] = useState(''),
    [inviteUrl, setInviteUrl] = useState('')
  const mutation = trpc.groups.access.useMutation({
    onSuccess: async (result) => {
      if (result.invitation) {
        setInviteUrl(result.invitation.url)
        setEmail('')
      }
      await utils.groups.invalidate()
      if (!result.joined) router.push('/groups')
    },
  })
  if (!data) return null
  const admin = data.access.role === 'admin'
  return (
    <section className="border bg-card p-5 sm:p-8 space-y-6" id="members">
      <div className="space-y-2">
        <h2 className="font-display text-3xl">Members & invitations</h2>
        <p className="text-sm text-muted-foreground">
          This group is private. Members can manage expenses; admins also manage
          group settings and invitations. Bookkeeping participants can include
          people who have not joined.
        </p>
      </div>
      {admin && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate({ action: 'invite', groupId, email })
          }}
        >
          <label htmlFor="invite-email" className="block text-sm font-medium">
            Invite by Google email
          </label>
          <div className="flex flex-wrap gap-3">
            <Input
              id="invite-email"
              className="flex-1 min-w-40"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="roommate@gmail.com"
            />
            <Button disabled={mutation.isPending}>Create invitation</Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Send the link yourself. It expires in 7 days and can only be
            accepted by that email address.
          </p>
        </form>
      )}
      {inviteUrl && (
        <div className="border p-3 flex gap-3 items-center">
          <code className="flex-1 min-w-0 break-all text-xs">{inviteUrl}</code>
          <CopyButton text={inviteUrl} title="Copy invitation" />
        </div>
      )}
      {mutation.error && (
        <p role="alert" className="text-destructive">
          {mutation.error.message}
        </p>
      )}
      <ul className="divide-y">
        {data.access.members.map((member) => (
          <li
            key={member.id}
            className="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <div className="min-w-0">
              <p className="font-medium">
                {member.name}{' '}
                <span className="text-xs font-normal text-muted-foreground">
                  {member.role}
                </span>
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {member.email}
              </p>
            </div>
            {admin && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mutation.isPending}
                  onClick={() =>
                    mutation.mutate({
                      action: 'set_role',
                      groupId,
                      userId: member.id,
                      role: member.role === 'admin' ? 'member' : 'admin',
                    })
                  }
                >
                  {member.role === 'admin' ? 'Make member' : 'Make admin'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mutation.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove ${member.name} from this group? Their historical expenses will remain.`,
                      )
                    )
                      mutation.mutate({
                        action: 'remove_member',
                        groupId,
                        userId: member.id,
                      })
                  }}
                >
                  Remove
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {admin && data.access.invitations.length > 0 && (
        <div>
          <h3 className="font-medium mb-2">Pending invitations</h3>
          <ul className="divide-y">
            {data.access.invitations.map((invite) => (
              <li
                key={invite.id}
                className="flex gap-4 justify-between items-center py-3"
              >
                <span className="break-all text-sm">{invite.email}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={mutation.isPending}
                  onClick={() =>
                    mutation.mutate({
                      action: 'revoke_invitation',
                      groupId,
                      invitationId: invite.id,
                    })
                  }
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Button
        variant="outline"
        disabled={mutation.isPending}
        onClick={() => {
          if (
            window.confirm(
              'Leave this group? You will need a new invitation to return.',
            )
          )
            mutation.mutate({ action: 'leave', groupId })
        }}
      >
        Leave group
      </Button>
    </section>
  )
}
