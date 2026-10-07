'use client'

import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { trpc } from '@/trpc/client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function GroupMembers({ groupId }: { groupId: string }) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const { data, error } = trpc.groups.getDetails.useQuery({ groupId })
  const [inviting, setInviting] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [invitation, setInvitation] = useState<{
    participantId: string
    url: string
  } | null>(null)
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(
    null,
  )
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const mutation = trpc.groups.access.useMutation({
    onSuccess: async (result) => {
      if (result.invitation) {
        setInvitation({
          participantId: result.invitation.participantId,
          url: result.invitation.url,
        })
        setInviting(null)
        setEmail('')
      } else {
        setInvitation(null)
      }
      await utils.groups.invalidate()
      if (!result.joined) router.push('/groups')
    },
  })
  const update = trpc.groups.update.useMutation({
    onSuccess: async () => {
      setNewName('')
      setEditing(null)
      await utils.groups.invalidate()
    },
  })
  if (error) return <p role="alert">{error.message}</p>
  if (!data) return <p role="status">Loading people…</p>
  const admin = data.access.role === 'admin'
  const busy = mutation.isPending || update.isPending
  const people = data.group.participants
  const savePeople = ({
    participants,
  }: {
    participants: { id?: string; name: string }[]
  }) =>
    update.mutate({
      groupId,
      expectedRevision: data.group.revision,
      groupFormValues: { participants },
    })
  const memberActions = ({
    member,
  }: {
    member: (typeof data.access.members)[number]
  }) =>
    admin && (
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
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
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                `Remove ${member.name}'s access? Their expenses will remain.`,
              )
            )
              mutation.mutate({
                action: 'remove_member',
                groupId,
                userId: member.id,
              })
          }}
        >
          Remove access
        </Button>
      </div>
    )

  return (
    <section
      className="border bg-card p-5 sm:p-8 space-y-6"
      id="members"
      aria-labelledby="people-heading"
    >
      <div className="space-y-2">
        <h2 id="people-heading" className="font-display text-3xl">
          People
        </h2>
        <p className="text-sm text-muted-foreground">
          Track expenses for everyone here. Invite people to give them access.
        </p>
      </div>
      {(mutation.error || update.error) && (
        <p role="alert" className="text-destructive">
          {mutation.error?.message ?? update.error?.message}
        </p>
      )}
      <ul className="divide-y" aria-label="People">
        {people.map((person) => {
          const member = data.access.members.find(
            (m) => m.participantId === person.id,
          )
          const pending = data.access.invitations.find(
            (i) => i.participantId === person.id,
          )
          const fixed = data.access.reservedParticipantIds.includes(person.id)
          const protectedPerson =
            fixed || data.participantsWithExpenses.includes(person.id)
          return (
            <li
              key={person.id}
              className="py-4 space-y-3"
              aria-label={person.name}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium break-words">
                    {person.name}
                    {data.access.participantId === person.id ? ' (you)' : ''}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {member
                      ? `Joined · ${member.role === 'admin' ? 'Admin' : 'Member'}`
                      : pending
                        ? 'Invited'
                        : 'Not joined'}
                  </p>
                  {(member || pending) && (
                    <p className="text-xs text-muted-foreground break-all">
                      {member?.email ?? pending?.email}
                    </p>
                  )}
                </div>
                {member
                  ? memberActions({ member })
                  : admin && (
                      <div className="flex flex-wrap gap-2">
                        {pending ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              mutation.mutate({
                                action: 'revoke_invitation',
                                groupId,
                                invitationId: pending.id,
                              })
                            }
                          >
                            Revoke invitation
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              setInviting(person.id)
                              setEmail('')
                              mutation.reset()
                            }}
                          >
                            Invite
                          </Button>
                        )}
                        {!fixed && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              setEditing({ id: person.id, name: person.name })
                              update.reset()
                            }}
                          >
                            Edit name
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || protectedPerson}
                          title={
                            protectedPerson
                              ? 'People with expenses or account links cannot be deleted.'
                              : undefined
                          }
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete ${person.name} from this group?`,
                              )
                            )
                              savePeople({
                                participants: people.filter(
                                  (p) => p.id !== person.id,
                                ),
                              })
                          }}
                        >
                          Delete person
                        </Button>
                      </div>
                    )}
              </div>
              {admin && editing?.id === person.id && (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (editing.name.trim())
                      savePeople({
                        participants: people.map((p) => ({
                          id: p.id,
                          name:
                            p.id === person.id ? editing.name.trim() : p.name,
                        })),
                      })
                  }}
                >
                  <div className="flex-1 min-w-0 space-y-1">
                    <label className="text-sm" htmlFor={`name-${person.id}`}>
                      Name for {person.name}
                    </label>
                    <Input
                      id={`name-${person.id}`}
                      required
                      maxLength={50}
                      value={editing.name}
                      onChange={(event) =>
                        setEditing({ ...editing, name: event.target.value })
                      }
                    />
                  </div>
                  <Button size="sm" disabled={busy || !editing.name.trim()}>
                    Save name
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </Button>
                </form>
              )}
              {admin && inviting === person.id && !member && !pending && (
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    mutation.mutate({
                      action: 'invite',
                      groupId,
                      participantId: person.id,
                      email,
                    })
                  }}
                >
                  <label className="text-sm" htmlFor={`invite-${person.id}`}>
                    Google email for {person.name}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Input
                      id={`invite-${person.id}`}
                      className="flex-1 min-w-0"
                      type="email"
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="roommate@gmail.com"
                    />
                    <Button disabled={busy}>Create invitation</Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setInviting(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Only this Google account can join as {person.name}. Share
                    the invitation link; it expires in 7 days.
                  </p>
                </form>
              )}
              {admin && pending && invitation?.participantId === person.id && (
                <div className="border p-3 flex gap-3 items-center">
                  <code className="flex-1 min-w-0 break-all text-xs">
                    {invitation.url}
                  </code>
                  <CopyButton text={invitation.url} title="Copy invitation" />
                </div>
              )}
            </li>
          )
        })}
        {data.access.members
          .filter((member) => !member.participantId)
          .map((member) => (
            <li key={member.id} className="py-4 space-y-3">
              <p className="font-medium">{member.name}</p>
              <p className="text-sm text-muted-foreground">
                Joined · Identity needs setup
              </p>
              <p className="text-xs break-all">{member.email}</p>
              {admin && (
                <div className="flex flex-wrap gap-2">
                  <select
                    aria-label={`Person for ${member.name}`}
                    value={bindings[member.id] ?? ''}
                    onChange={(event) =>
                      setBindings({
                        ...bindings,
                        [member.id]: event.target.value,
                      })
                    }
                    className="h-9 max-w-full border bg-background px-2 text-sm"
                  >
                    <option value="">Choose their person</option>
                    {people
                      .filter(
                        (p) =>
                          !data.access.reservedParticipantIds.includes(p.id),
                      )
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                  <Button
                    size="sm"
                    disabled={busy || !bindings[member.id]}
                    onClick={() => {
                      const name = people.find(
                        (p) => p.id === bindings[member.id],
                      )?.name
                      if (
                        window.confirm(
                          `Permanently link ${member.email} to ${name}? This identity cannot be switched later.`,
                        )
                      )
                        mutation.mutate({
                          action: 'bind_member',
                          groupId,
                          userId: member.id,
                          email: member.email,
                          participantId: bindings[member.id],
                        })
                    }}
                  >
                    Link identity
                  </Button>
                </div>
              )}
              {memberActions({ member })}
            </li>
          ))}
      </ul>
      {admin &&
        data.access.invitations
          .filter((i) => !i.participantId)
          .map((invite) => (
            <div key={invite.id} className="flex flex-wrap gap-3 items-center">
              <p className="text-sm break-all">
                {invite.email} · Old invitation needs reissuing
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  mutation.mutate({
                    action: 'revoke_invitation',
                    groupId,
                    invitationId: invite.id,
                  })
                }
              >
                Revoke invitation
              </Button>
            </div>
          ))}
      {admin && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (newName.trim())
              savePeople({
                participants: [...people, { name: newName.trim() }],
              })
          }}
        >
          <label htmlFor="new-person" className="text-sm">
            New person&apos;s name
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="new-person"
              className="flex-1 min-w-0"
              maxLength={50}
              required
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <Button disabled={busy || !newName.trim()}>Add person</Button>
          </div>
        </form>
      )}
      <Button
        variant="outline"
        disabled={busy}
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
