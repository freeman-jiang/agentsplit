import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChevronDown, Copy } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { GroupForm } from '~/client/components/group-form'
import { errorMessage, groupDetailsQuery, newIdempotencyKey, refreshGroups } from '~/client/queries/groups'
import { rpc } from '~/client/rpc'
import { Alert, AlertDescription } from '~/client/ui/alert'
import { Button } from '~/client/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '~/client/ui/dropdown-menu'
import { Input } from '~/client/ui/input'
import { NativeSelect } from '~/client/ui/native-select'
import type { AccessRequest, GroupChanges, GroupDetails } from '~/shared/api'
import { groupRef } from '~/shared/groups'
import { LIMITS } from '~/shared/limits'
import type { Role } from '~/shared/vocabulary'

export const Route = createFileRoute('/$group/edit')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(groupDetailsQuery(params.group)),
  pendingComponent: () => <p role="status">Loading people…</p>,
  errorComponent: ({ error }) => <p role="alert">{errorMessage(error)}</p>,
  component: Settings,
})

type Details = typeof GroupDetails.Type

function Settings() {
  const { group } = Route.useParams()
  const { data } = useSuspenseQuery(groupDetailsQuery(group))
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return (
    <div className="space-y-6">
      {/* Only admins can change settings, so members see only the People section (P-GROUP-59). */}
      {data.role === 'admin' && (
        <GroupForm
          key={data.revision}
          mode="edit"
          initial={{ name: data.name, slug: data.slug ?? '', information: data.information, defaultCurrency: data.defaultCurrency }}
          onSubmit={async (values) => {
            const result = await rpc((api) =>
              api('groups.update', {
                groupId: data.id,
                expectedRevision: data.revision,
                idempotencyKey: newIdempotencyKey(),
                changes: { ...values, slug: values.slug.trim() || null },
              }),
            ).catch(async (e: unknown) => {
              await refreshGroups(queryClient)
              throw new Error(errorMessage(e))
            })
            await refreshGroups(queryClient)
            toast.success('Group settings saved')
            // A new or removed slug changes the page's URL (P-GROUP-104).
            if (groupRef(result) !== group) await navigate({ to: '/$group/edit', params: { group: groupRef(result) }, replace: true })
          }}
        />
      )}
      <People details={data} />
    </div>
  )
}

/** One access or people change at a time, with its error shown at the top of the section. */
function useActions(details: Details) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async <A,>(work: () => Promise<A>): Promise<A | null> => {
    setBusy(true)
    setError(null)
    try {
      return await work()
    } catch (e) {
      setError(errorMessage(e))
      return null
    } finally {
      await refreshGroups(queryClient)
      setBusy(false)
    }
  }
  return {
    busy,
    error,
    access: (request: typeof AccessRequest.Type) =>
      run(async () => {
        const result = await rpc((api) => api('groups.access', { idempotencyKey: newIdempotencyKey(), request }))
        if (!result.joined) {
          queryClient.removeQueries({ queryKey: ['group'] })
          await navigate({ to: '/groups' })
        }
        return result
      }),
    savePeople: (participants: NonNullable<(typeof GroupChanges.Type)['participants']>) =>
      run(() =>
        rpc((api) =>
          api('groups.update', { groupId: details.id, expectedRevision: details.revision, idempotencyKey: newIdempotencyKey(), changes: { participants } }),
        ),
      ),
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Copied')
  } catch {
    toast.error('Could not copy. Select the text and copy it yourself.')
  }
}

function CopyButton({ text, title }: { text: string; title: string }) {
  return (
    <Button type="button" variant="outline" size="icon" className="shrink-0" title={title} aria-label={title} onClick={() => copy(text)}>
      <Copy className="h-4 w-4" />
    </Button>
  )
}

function People({ details }: { details: Details }) {
  const actions = useActions(details)
  const admin = details.role === 'admin'
  const busy = actions.busy
  const [inviting, setInviting] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [created, setCreated] = useState<{ participantId: string; url: string; email: string; expiresAt: string } | null>(null)
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const people = details.people
  const list = (rename?: { id: string; name: string }) => people.map((p) => ({ id: p.id, name: p.id === rename?.id ? rename.name : p.name }))

  const memberActions = (member: { userId: string; name: string; role: Role }) =>
    admin && (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={`Manage access for ${member.name}`} disabled={busy} className="text-muted-foreground">
            Manage access <ChevronDown aria-hidden="true" className="ml-1 h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={busy}
            onSelect={() => actions.access({ action: 'set_role', groupId: details.id, userId: member.userId, role: member.role === 'admin' ? 'member' : 'admin' })}
          >
            {member.role === 'admin' ? 'Remove admin role' : 'Make admin'}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={busy}
            onSelect={() => {
              if (window.confirm(`Remove ${member.name}'s access? Their expenses will remain.`))
                void actions.access({ action: 'remove_member', groupId: details.id, userId: member.userId })
            }}
          >
            Remove access
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )

  return (
    <section className="scroll-mt-24 space-y-4 rounded-2xl border bg-card p-6" id="members" aria-labelledby="people-heading">
      <div className="space-y-1.5">
        <h2 id="people-heading" className="text-base font-semibold leading-tight">
          People
        </h2>
        <p className="text-sm text-muted-foreground">Track expenses for everyone here. Invite people to give them access.</p>
      </div>
      {actions.error && (
        <Alert variant="destructive">
          <AlertDescription>{actions.error}</AlertDescription>
        </Alert>
      )}
      <ul className="divide-y" aria-label="People">
        {people.map((person) => {
          const pending = details.invitations.find((i) => i.participantId === person.id)
          const member = person.status === 'joined' && person.userId && person.role ? { userId: person.userId, name: person.name, role: person.role } : null
          return (
            <li key={person.id} className="space-y-3 py-3" aria-label={person.name}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-medium break-words">
                    {person.name}
                    {details.participantId === person.id && <span className="font-normal text-muted-foreground"> (you)</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {member ? `Joined · ${member.role === 'admin' ? 'Admin' : 'Member'}` : person.status === 'invited' ? 'Invited' : 'Not joined'}
                  </p>
                  {person.email && <p className="text-xs break-all text-muted-foreground">{person.email}</p>}
                </div>
                {member
                  ? memberActions(member)
                  : admin && (
                      <div className="flex flex-wrap gap-2">
                        {pending ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={async () => {
                              if (await actions.access({ action: 'revoke_invitation', groupId: details.id, invitationId: pending.id })) setCreated(null)
                            }}
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
                            }}
                          >
                            Invite
                          </Button>
                        )}
                        {!person.reserved && (
                          <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing({ id: person.id, name: person.name })}>
                            Edit name
                          </Button>
                        )}
                        {/* People in an expense, bound or invited cannot be removed (P-GROUP-84). */}
                        {!person.reserved && !person.inExpenses && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              if (window.confirm(`Delete ${person.name} from this group?`)) void actions.savePeople(list().filter((p) => p.id !== person.id))
                            }}
                          >
                            Delete person
                          </Button>
                        )}
                      </div>
                    )}
              </div>
              {admin && editing?.id === person.id && (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={async (event) => {
                    event.preventDefault()
                    const name = editing.name.trim()
                    if (name && (await actions.savePeople(list({ id: person.id, name })))) setEditing(null)
                  }}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <label className="text-sm" htmlFor={`name-${person.id}`}>
                      Name for {person.name}
                    </label>
                    <Input id={`name-${person.id}`} required maxLength={LIMITS.nameMax} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                  </div>
                  <Button size="sm" disabled={busy || !editing.name.trim()}>
                    Save name
                  </Button>
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              )}
              {admin && inviting === person.id && !member && !pending && (
                <form
                  className="space-y-2"
                  onSubmit={async (event) => {
                    event.preventDefault()
                    const result = await actions.access({ action: 'invite', groupId: details.id, participantId: person.id, email: email.trim() })
                    const invitation = result?.invitation
                    if (invitation?.url) {
                      setCreated({ participantId: person.id, url: invitation.url, email: invitation.email, expiresAt: invitation.expiresAt })
                      setInviting(null)
                      setEmail('')
                    }
                  }}
                >
                  <label className="text-sm" htmlFor={`invite-${person.id}`}>
                    Google email for {person.name}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Input
                      id={`invite-${person.id}`}
                      className="min-w-0 flex-1"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="roommate@gmail.com"
                    />
                    <Button disabled={busy}>Create invitation</Button>
                    <Button type="button" variant="ghost" disabled={busy} onClick={() => setInviting(null)}>
                      Cancel
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Only this Google account can join as {person.name}. Share the invitation link; it expires in {LIMITS.invitationDays} days.
                  </p>
                </form>
              )}
              {/* The link exists only in this page's memory: after a reload the person shows "Invited" (P-ACCESS-24). */}
              {admin && pending && created?.participantId === person.id && (
                <div className="space-y-3 rounded-xl bg-muted/50 p-3">
                  <p className="text-sm">Send this to {person.name}. AgentSplit does not send an email automatically.</p>
                  <div className="flex items-center gap-3">
                    <code className="min-w-0 flex-1 text-xs break-all">{created.url}</code>
                    <CopyButton text={created.url} title="Copy invitation" />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm">Copy a message with the steps to join</span>
                    <CopyButton
                      title="Copy invitation message"
                      text={`Join ${details.name} on AgentSplit:\n${created.url}\n\nOpen the link and sign in with Google using ${created.email}. Your account will be created automatically if you’re new. Then click Accept invitation to join as ${person.name} and see our shared expenses and balances.\n\nYou can use the website, or open Agents after joining to connect ChatGPT or Claude. An agent is optional.\n\nThe invitation expires ${new Date(created.expiresAt).toLocaleString()}.`}
                    />
                  </div>
                </div>
              )}
            </li>
          )
        })}
        {details.unboundMembers.map((member) => (
          <li key={member.userId} className="space-y-3 py-3">
            <p className="text-sm font-medium">{member.name}</p>
            <p className="text-xs text-muted-foreground">Joined · Identity needs setup</p>
            <p className="text-xs break-all">{member.email}</p>
            {admin && (
              <div className="flex flex-wrap gap-2">
                <NativeSelect
                  aria-label={`Person for ${member.name}`}
                  value={bindings[member.userId] ?? ''}
                  onChange={(e) => setBindings({ ...bindings, [member.userId]: e.target.value })}
                  wrapperClassName="max-w-full"
                  className="h-9"
                >
                  <option value="">Choose their person</option>
                  {people
                    .filter((p) => !p.reserved)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </NativeSelect>
                <Button
                  size="sm"
                  disabled={busy || !bindings[member.userId]}
                  onClick={() => {
                    const participantId = bindings[member.userId]
                    const name = people.find((p) => p.id === participantId)?.name
                    if (participantId && window.confirm(`Permanently link ${member.email} to ${name}? This identity cannot be switched later.`))
                      void actions.access({ action: 'bind_member', groupId: details.id, userId: member.userId, email: member.email, participantId })
                  }}
                >
                  Link identity
                </Button>
              </div>
            )}
            {memberActions(member)}
          </li>
        ))}
      </ul>
      {admin &&
        details.invitations
          .filter((i) => !i.participantId)
          .map((invite) => (
            <div key={invite.id} className="flex flex-wrap items-center gap-3">
              <p className="text-sm break-all">{invite.email} · Old invitation needs reissuing</p>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => actions.access({ action: 'revoke_invitation', groupId: details.id, invitationId: invite.id })}>
                Revoke invitation
              </Button>
            </div>
          ))}
      {admin && (
        <form
          className="space-y-2"
          onSubmit={async (event) => {
            event.preventDefault()
            const name = newName.trim()
            if (name && (await actions.savePeople([...list(), { name }]))) setNewName('')
          }}
        >
          <label htmlFor="new-person" className="text-sm">
            New person&apos;s name
          </label>
          <div className="flex flex-wrap gap-2">
            <Input id="new-person" className="min-w-0 flex-1" maxLength={LIMITS.nameMax} required value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Button disabled={busy || !newName.trim()}>Add person</Button>
          </div>
        </form>
      )}
      {/* Leaving is destructive, so it sits apart from the people actions. */}
      <div className="border-t pt-4">
        <Button
          variant="ghost"
          className="-ms-4 text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={busy}
          onClick={() => {
            if (window.confirm('Leave this group? You will need a new invitation to return.')) void actions.access({ action: 'leave', groupId: details.id })
          }}
        >
          Leave group
        </Button>
      </div>
    </section>
  )
}
