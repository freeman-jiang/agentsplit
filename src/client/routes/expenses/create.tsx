import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ExpenseForm, type PageTarget } from '~/client/components/expense-form'
import { newExpenseState } from '~/client/components/expense-form-state'
import { rpc } from '~/client/rpc'
import { referenceQuery } from '~/client/queries/expenses'
import { errorMessage, expenseContextQuery, feedOptionsQuery, invalidateExpenses } from '~/client/queries/feed'
import { Button } from '~/client/ui/button'
import { Input } from '~/client/ui/input'
import { NativeSelect } from '~/client/ui/native-select'
import { randomId } from '~/shared/ids'
import type { FeedOptions, Reference, UngroupedResult } from '~/shared/api'

export const Route = createFileRoute('/expenses/create')({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(feedOptionsQuery)
    void context.queryClient.prefetchQuery(referenceQuery)
  },
  component: NewExpense,
})

type Person = { id: string; name: string; email: string; userId?: string }
type Options = typeof FeedOptions.Type
type Invitations = (typeof UngroupedResult.Type)['invitations']
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function NewExpense() {
  const options = useQuery(feedOptionsQuery)
  if (options.error) return <p role="alert">{errorMessage(options.error)}</p>
  if (!options.data) return <p role="status">Loading people and groups…</p>
  return <ExpenseSetup options={options.data} />
}

function ExpenseSetup({ options }: { options: Options }) {
  const self = options.people.find((p) => p.id === options.userId)
  // One ID per form: a retried save cannot create a second expense.
  const [id] = useState(() => randomId())
  const [people, setPeople] = useState<Person[]>(() => (self ? [{ id: randomId(), userId: self.id, name: self.name, email: self.email }] : []))
  const [groupId, setGroupId] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [invitations, setInvitations] = useState<Invitations | null>(null)
  const reference = useQuery(referenceQuery)
  const navigate = useNavigate()
  if (!self) return <p role="alert">Your verified account could not be loaded.</p>
  if (invitations)
    return (
      <div className="space-y-5">
        <h1 className="font-display text-3xl">Expense saved</h1>
        <p>Share these private invitations with the people listed. Each link works only for its email address.</p>
        {invitations.map((invitation) => (
          <label key={invitation.email} className="block space-y-2 text-sm">
            <span>{invitation.email}</span>
            <Input readOnly value={invitation.url} onFocus={(event) => event.currentTarget.select()} />
          </label>
        ))}
        <Button asChild>
          <Link to="/expenses/$expenseId" params={{ expenseId: id }}>
            View expense
          </Link>
        </Button>
      </div>
    )
  if (editing)
    return (
      <div className="space-y-5">
        <Button variant="ghost" onClick={() => setEditing(false)}>
          ← Change people
        </Button>
        <p className="text-sm text-muted-foreground">
          No group · Private to {people.map((p) => p.name).join(', ')}. You can attach receipts after saving.
        </p>
        {reference.data ? (
          <PrivateExpense id={id} people={people} selfId={self.id} reference={reference.data} onInvitations={setInvitations} />
        ) : reference.error ? (
          <p role="alert">{errorMessage(reference.error)}</p>
        ) : (
          <p role="status">Loading categories…</p>
        )}
      </div>
    )
  const addInvited = () => {
    const normalized = email.trim().toLowerCase()
    if (!name.trim() || name.trim().length > 50 || !EMAIL.test(normalized)) return setError('Enter a name and a valid email address.')
    if (people.some((p) => p.email.toLowerCase() === normalized)) return setError('That person is already included.')
    // A known contact's email links that account, so no invitation is needed.
    const existing = options.people.find((p) => p.email.toLowerCase() === normalized)
    setPeople((current) => [...current, { id: randomId(), name: existing?.name ?? name.trim(), email: normalized, ...(existing ? { userId: existing.id } : {}) }])
    setName('')
    setEmail('')
    setError('')
  }
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Link to="/" className="text-sm underline">
          ← Expenses
        </Link>
        <h1 className="mt-4 font-display text-3xl">Add expense</h1>
        <p className="mt-2 text-sm text-muted-foreground">Choose a group, or split privately with people.</p>
      </div>
      <label className="block space-y-2 text-sm">
        <span>Group (optional)</span>
        <NativeSelect value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">No group</option>
          {options.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </NativeSelect>
      </label>
      {!groupId && (
        <section className="space-y-4" aria-label="Expense participants">
          <h2 className="font-display text-xl">Who’s involved?</h2>
          <ul className="divide-y overflow-hidden rounded-2xl border px-4">
            {people.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-4 py-3">
                <div>
                  <p className="text-sm font-medium">
                    {p.name}
                    {p.userId === self.id ? ' (you)' : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {p.email}
                    {!p.userId ? ' · Invitation needed' : ''}
                  </p>
                </div>
                {p.userId !== self.id && (
                  <Button size="sm" variant="ghost" aria-label={`Remove ${p.name}`} onClick={() => setPeople((current) => current.filter((person) => person.id !== p.id))}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <label className="block space-y-2 text-sm">
            <span>Add an existing person</span>
            <NativeSelect
              value=""
              onChange={(event) => {
                const person = options.people.find((p) => p.id === event.target.value)
                if (person) setPeople((current) => [...current, { id: randomId(), userId: person.id, name: person.name, email: person.email }])
              }}
            >
              <option value="">Choose a person</option>
              {options.people
                .filter((p) => !people.some((chosen) => chosen.email.toLowerCase() === p.email.toLowerCase()))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.email})
                  </option>
                ))}
            </NativeSelect>
          </label>
          <details className="rounded-2xl border p-4">
            <summary className="cursor-pointer text-sm font-medium">Invite someone new by email</summary>
            <div className="mt-4 space-y-3">
              <label className="block space-y-2 text-sm">
                <span>Name</span>
                <Input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="block space-y-2 text-sm">
                <span>Email</span>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <Button variant="outline" onClick={addInvited}>
                Add person
              </Button>
              <p className="text-xs text-muted-foreground">After saving, you’ll get an invitation link to share. No email or chat message is sent automatically.</p>
            </div>
          </details>
        </section>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        disabled={!groupId && (people.length < 2 || options.categories.length === 0)}
        onClick={() => {
          const group = options.groups.find((g) => g.id === groupId)
          if (group) void navigate({ to: '/$group/expenses/create', params: { group: group.slug ?? group.id } })
          else setEditing(true)
        }}
      >
        Continue to expense
      </Button>
    </div>
  )
}

/** The full expense form for a new ungrouped expense, with the people chosen above. */
function PrivateExpense(props: { id: string; people: readonly Person[]; selfId: string; reference: typeof Reference.Type; onInvitations: (invitations: Invitations) => void }) {
  const { id, people } = props
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const me = people.find((p) => p.userId === props.selfId)
  // The context does not exist until the save, so the expense ID stands in for the group ID.
  const group = { id, participants: people.map((p) => ({ id: p.id, name: p.name })), participantId: me?.id ?? null, defaultCurrency: 'USD' as const }
  const [initial] = useState(() =>
    newExpenseState({ groupId: null, participants: people.map((p) => p.id), viewer: me?.id ?? null, defaultCurrency: group.defaultCurrency, prefill: {} }),
  )
  const target: PageTarget = {
    kind: 'page',
    privateExpense: true,
    back: { to: '/' },
    create: async ({ expense, idempotencyKey }) => {
      const open = async () => {
        await invalidateExpenses(queryClient)
        await navigate({ to: '/expenses/$expenseId', params: { expenseId: id } })
      }
      try {
        const result = await rpc((api) =>
          api('expenses.createUngrouped', {
            expenseId: id,
            idempotencyKey,
            expense,
            people: people.map((p) => (p.userId ? { kind: 'account', id: p.id, userId: p.userId } : { kind: 'email', id: p.id, name: p.name, email: p.email })),
          }),
        )
        if (!result.invitations.length) return await open()
        await invalidateExpenses(queryClient)
        props.onInvitations(result.invitations)
      } catch (cause) {
        // The save may have reached the server: if the expense exists now, open it (P-UNGROUP-19).
        const saved = await queryClient.fetchQuery(expenseContextQuery(id)).catch(() => null)
        if (!saved) throw cause
        await open()
      }
    },
  }
  return <ExpenseForm mode="create" expenseId={id} group={group} reference={props.reference} target={target} initial={initial} />
}
