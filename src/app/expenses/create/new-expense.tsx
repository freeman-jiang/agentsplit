'use client'

import { ExpenseForm } from '@/app/groups/[groupId]/expenses/expense-form'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { groupPath } from '@/lib/group-slug'
import { randomId } from '@/lib/random'
import { trpc } from '@/trpc/client'
import type { AppRouterOutput } from '@/trpc/routers/_app'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { z } from 'zod'

type Person = { id: string; name: string; email: string; userId?: string }
type Options = AppRouterOutput['expenses']['options']

export function NewExpense() {
  const options = trpc.expenses.options.useQuery()
  if (options.error) return <p role="alert">{options.error.message}</p>
  if (!options.data) return <p role="status">Loading people and groups…</p>
  return <ExpenseSetup options={options.data} />
}

function ExpenseSetup({ options }: { options: Options }) {
  const self = options.people.find((p) => p.id === options.userId)
  const [id] = useState(() => randomId())
  const [people, setPeople] = useState<Person[]>(() =>
    self
      ? [
          {
            id: randomId(),
            userId: self.id,
            name: self.name,
            email: self.email,
          },
        ]
      : [],
  )
  const [groupId, setGroupId] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [invitations, setInvitations] = useState<
    AppRouterOutput['expenses']['createUngrouped']['invitations'] | null
  >(null)
  const categories = trpc.categories.list.useQuery()
  const create = trpc.expenses.createUngrouped.useMutation()
  const utils = trpc.useUtils()
  const router = useRouter()
  if (!self)
    return <p role="alert">Your verified account could not be loaded.</p>
  if (invitations)
    return (
      <div className="space-y-5">
        <h1 className="font-display text-3xl">Expense saved</h1>
        <p>
          Share these private invitations with the people listed. Each link
          works only for its email address.
        </p>
        {invitations.map((invitation) => (
          <label key={invitation.email} className="block space-y-2 text-sm">
            <span>{invitation.email}</span>
            <Input
              readOnly
              value={invitation.url}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
        ))}
        <Button asChild>
          <Link href={`/expenses/${id}`}>View expense</Link>
        </Button>
      </div>
    )
  if (editing && categories.data) {
    const group = {
      id,
      name: 'No group',
      slug: null,
      currency: '$',
      currencyCode: 'USD',
      information: null,
      createdAt: new Date(),
      revision: 1,
      participants: people.map((p) => ({
        id: p.id,
        name: p.name,
        groupId: id,
      })),
    }
    return (
      <div className="space-y-5">
        <Button variant="ghost" onClick={() => setEditing(false)}>
          ← Change people
        </Button>
        <p className="text-sm text-muted-foreground">
          No group · Private to {people.map((p) => p.name).join(', ')}. You can
          attach receipts after saving.
        </p>
        <ExpenseForm
          group={group}
          categories={categories.data.categories}
          expenseId={id}
          privateExpense
          draftParticipantId={people.find((p) => p.userId === self.id)?.id}
          cancelHref="/"
          runtimeFeatureFlags={{
            enableExpenseDocuments: false,
            enableCategoryExtract: false,
            enableReceiptExtract: false,
          }}
          onSubmit={async (expense) => {
            try {
              const result = await create.mutateAsync({
                expenseId: id,
                expense,
                people: people.map((p) =>
                  p.userId
                    ? { kind: 'account', id: p.id, userId: p.userId }
                    : { kind: 'email', id: p.id, name: p.name, email: p.email },
                ),
              })
              await utils.expenses.invalidate()
              if (result.invitations.length) setInvitations(result.invitations)
              else router.push(`/expenses/${id}`)
            } catch (cause) {
              const saved = await utils.expenses.context
                .fetch({ expenseId: id })
                .catch(() => null)
              if (saved) {
                await utils.expenses.invalidate()
                router.push(`/expenses/${id}`)
                return
              }
              throw cause
            }
          }}
        />
      </div>
    )
  }
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Link href="/" className="text-sm underline">
          ← Expenses
        </Link>
        <h1 className="mt-4 font-display text-3xl">Add expense</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose a group, or split privately with people.
        </p>
      </div>
      <label className="block space-y-2 text-sm">
        <span>Group (optional)</span>
        <NativeSelect
          value={groupId}
          onChange={(e) => setGroupId(e.target.value)}
        >
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
          <ul className="divide-y border px-4">
            {people.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-4 py-3"
              >
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
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${p.name}`}
                    onClick={() =>
                      setPeople((current) =>
                        current.filter((person) => person.id !== p.id),
                      )
                    }
                  >
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
                const person = options.people.find(
                  (p) => p.id === event.target.value,
                )
                if (person)
                  setPeople((current) => [
                    ...current,
                    {
                      id: randomId(),
                      userId: person.id,
                      name: person.name,
                      email: person.email,
                    },
                  ])
              }}
            >
              <option value="">Choose a person</option>
              {options.people
                .filter(
                  (p) =>
                    !people.some(
                      (chosen) =>
                        chosen.email.toLowerCase() === p.email.toLowerCase(),
                    ),
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.email})
                  </option>
                ))}
            </NativeSelect>
          </label>
          <details className="border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Invite someone new by email
            </summary>
            <div className="mt-4 space-y-3">
              <label className="block space-y-2 text-sm">
                <span>Name</span>
                <Input
                  value={name}
                  maxLength={50}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="block space-y-2 text-sm">
                <span>Email</span>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <Button
                variant="outline"
                onClick={() => {
                  const normalized = email.trim().toLowerCase()
                  if (
                    !name.trim() ||
                    !z.email().safeParse(normalized).success
                  ) {
                    setError('Enter a name and a valid email address.')
                    return
                  }
                  if (
                    people.some((p) => p.email.toLowerCase() === normalized)
                  ) {
                    setError('That person is already included.')
                    return
                  }
                  const existing = options.people.find(
                    (p) => p.email.toLowerCase() === normalized,
                  )
                  setPeople((current) => [
                    ...current,
                    {
                      id: randomId(),
                      name: existing?.name ?? name.trim(),
                      email: normalized,
                      userId: existing?.id,
                    },
                  ])
                  setName('')
                  setEmail('')
                  setError('')
                }}
              >
                Add person
              </Button>
              <p className="text-xs text-muted-foreground">
                After saving, you’ll get an invitation link to share. No email
                or chat message is sent automatically.
              </p>
            </div>
          </details>
        </section>
      )}
      {(error || categories.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || categories.error?.message}
        </p>
      )}
      <Button
        disabled={!groupId && (people.length < 2 || !categories.data)}
        onClick={() => {
          const group = options.groups.find((g) => g.id === groupId)
          if (group) router.push(`${groupPath(group)}/expenses/create`)
          else setEditing(true)
        }}
      >
        Continue to expense
      </Button>
    </div>
  )
}
