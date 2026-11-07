// Ungrouped (private) expenses. Each one gets its own private context: a
// hidden group whose ID is the expense ID and whose people never change. Only
// those people can see it, and repayments inside it settle only that expense.
// Ported from the current app's src/lib/ungrouped-expenses.ts and
// src/lib/ungrouped-access.ts; the database triggers in
// db/migrations/0003_private_contexts.sql enforce the same rules.
import { and, eq, isNull } from 'drizzle-orm'
import { expenses, groups, invitations, memberships, participants, privateContexts, privatePeople } from '../../db/schema/app'
import { Conflict, Forbidden, Invalid, Unauthorized } from '../shared/api'
import type { ExpenseDraft } from '../shared/expense-rules'
import { EMAIL } from '../shared/groups'
import { LIMITS, participantLimitMessage } from '../shared/limits'
import { requireMember, type Principal } from './access'
import { groupSnapshot, recordGroupEvent } from './activity'
import type { Db } from './db'
import { invitationTokenHash, newInvitationToken } from './groups'
import { randomId } from './ids'
import { createExpense } from './ledger'
import { contacts } from './people'

export type PrivatePerson =
  | { readonly kind: 'account'; readonly id: string; readonly userId: string }
  | { readonly kind: 'email'; readonly id: string; readonly name: string; readonly email: string }

/** A private link, in the format of a group invitation: the secret goes to the caller once; only its hash is stored. */
function newInvitationSecret() {
  const secret = newInvitationToken()
  return { secret, tokenHash: invitationTokenHash(secret) }
}

/**
 * Creates an ungrouped expense with two or more people: existing contacts by
 * account, or new people by exact email, who get a private link. The caller
 * must be one of the people, and the people must be exactly the payers and the
 * people who share the cost.
 *
 * The expense ID makes this write safe to retry: a second attempt fails with
 * Conflict, and the client then opens the saved expense. The response is not
 * stored for the idempotency key, because it holds the invitation secrets.
 */
export async function createUngroupedExpense(
  tx: Db,
  data: {
    principal: Principal
    baseUrl: string
    expenseId: string
    /** null for a caller that never retries with the same key. */
    idempotencyKey: string | null
    people: readonly PrivatePerson[]
    expense: ExpenseDraft
  },
) {
  const known = await contacts(tx, { userId: data.principal.userId })
  if (!known.some((c) => c.id === data.principal.userId)) throw new Unauthorized()
  if (data.people.length > LIMITS.participantsPerGroup) throw new Invalid({ message: participantLimitMessage, field: 'people' })
  const people = data.people.map((person) => {
    if (person.kind === 'account') {
      const account = known.find((c) => c.id === person.userId)
      if (!account) throw new Invalid({ message: 'Choose an existing contact or invite someone by email.', field: 'people' })
      return { localId: person.id, name: account.name, email: account.email.toLowerCase(), userId: account.id as string | null }
    }
    const name = person.name.trim()
    const email = person.email.trim().toLowerCase()
    if (!name || name.length > LIMITS.nameMax || !EMAIL.test(email)) throw new Invalid({ message: 'Enter a name and a valid email address.', field: 'people' })
    // An email that belongs to a known contact links that account; nobody needs an invitation then.
    const account = known.find((c) => c.email.toLowerCase() === email)
    return { localId: person.id, name: account?.name ?? name, email, userId: account?.id ?? null }
  })
  // A common prefix keeps the people's local order and makes reusable labels ("me", "friend") unique.
  const stored = people.map((p) => ({ ...p, id: `${data.expenseId}_${p.localId}` }))
  const involved = new Set([...data.expense.payers.map((p) => p.participantId), ...data.expense.shares.map((s) => s.participantId)])
  const self = stored.find((p) => p.userId === data.principal.userId)
  if (
    !self ||
    !involved.has(self.localId) ||
    stored.some((p) => !involved.has(p.localId)) ||
    involved.size !== stored.length ||
    new Set(stored.map((p) => p.localId)).size !== stored.length ||
    new Set(stored.map((p) => p.email)).size !== stored.length
  )
    throw new Invalid({
      message: 'Include yourself and exactly the people paying for or sharing this expense. Each person must be unique.',
      field: 'people',
    })
  if (data.expense.kind !== 'expense' || data.expense.recurrence !== 'none')
    throw new Invalid({ message: 'Create the expense first, then attach receipts or record a repayment. Ungrouped expenses do not recur.' })

  const [prior] = await tx
    .select({ revision: expenses.revision })
    .from(expenses)
    .where(eq(expenses.id, data.expenseId))
    .unionAll(tx.select({ revision: groups.revision }).from(groups).where(eq(groups.id, data.expenseId)))
  if (prior) throw new Conflict({ entity: 'expense', id: data.expenseId, currentRevision: prior.revision })

  const groupId = data.expenseId
  const group = { id: groupId, kind: 'private' as const, slug: null, name: data.expense.title, defaultCurrency: data.expense.currency, revision: 1 }
  await tx.insert(groups).values(group)
  await tx.insert(participants).values(stored.map((p) => ({ id: p.id, groupId, name: p.name })))
  await tx.insert(memberships).values(
    stored.flatMap((p) =>
      p.userId ? [{ userId: p.userId, groupId, participantId: p.id, role: p.userId === data.principal.userId ? ('admin' as const) : ('member' as const) }] : [],
    ),
  )
  await recordGroupEvent(tx, {
    groupId,
    type: 'create_group',
    principal: data.principal,
    data: 'Private expense',
    snapshot: groupSnapshot({ group: { ...group, information: '' }, participants: stored }),
  })
  const toStored = new Map(stored.map((p) => [p.localId, p.id]))
  const local = (id: string) => toStored.get(id) ?? id
  const created = await createExpense(tx, {
    principal: data.principal,
    group: groupId,
    expenseId: data.expenseId,
    idempotencyKey: data.idempotencyKey,
    expense: {
      ...data.expense,
      payers: data.expense.payers.map((p) => ({ ...p, participantId: local(p.participantId) })),
      shares: data.expense.shares.map((s) => ({ ...s, participantId: local(s.participantId) })),
    },
  })
  await tx.insert(privateContexts).values({ groupId, expenseId: data.expenseId })
  await tx.insert(privatePeople).values(stored.map((p) => ({ participantId: p.id, groupId, email: p.email })))

  const links = []
  for (const person of stored.filter((p) => !p.userId)) {
    const { secret, tokenHash } = newInvitationSecret()
    const expiresAt = new Date(Date.now() + LIMITS.invitationDays * 86_400_000)
    await tx.insert(invitations).values({
      id: randomId(),
      groupId,
      email: person.email,
      participantId: person.id,
      participantName: person.name,
      tokenHash,
      createdBy: data.principal.userId,
      expiresAt,
    })
    links.push({ email: person.email, url: new URL(`/invite/${secret}`, data.baseUrl).href, expiresAt: expiresAt.toISOString() })
  }
  return {
    expenseId: data.expenseId,
    groupId,
    revision: created.revision,
    invitations: links,
    participants: stored.map((p) => ({ localId: p.localId, participantId: p.id, name: p.name })),
  }
}

/**
 * Issues a new private link for an original person who has not joined, and
 * revokes the earlier ones. Only the expense's creator may do this. Like the
 * create, the response holds a secret, so it is not stored for the key; a retry
 * issues another link and revokes this one.
 */
export async function renewPrivateInvitation(tx: Db, data: { principal: Principal; baseUrl: string; groupId: string; participantId: string }) {
  const membership = await requireMember(tx, { principal: data.principal, group: data.groupId })
  const [person] = await tx
    .select({ email: privatePeople.email, name: participants.name, joined: memberships.userId })
    .from(privatePeople)
    .innerJoin(participants, eq(participants.id, privatePeople.participantId))
    .leftJoin(memberships, and(eq(memberships.groupId, privatePeople.groupId), eq(memberships.participantId, privatePeople.participantId)))
    .where(and(eq(privatePeople.participantId, data.participantId), eq(privatePeople.groupId, membership.groupId)))
  if (membership.role !== 'admin' || !person) throw new Forbidden({ message: 'Only the expense creator can reissue its original invitations.' })
  if (person.joined) throw new Invalid({ message: 'This person has already joined.', field: 'participantId', reason: 'state' })
  await tx
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(invitations.groupId, membership.groupId), eq(invitations.participantId, data.participantId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
  const { secret, tokenHash } = newInvitationSecret()
  const id = randomId()
  const expiresAt = new Date(Date.now() + LIMITS.invitationDays * 86_400_000)
  await tx.insert(invitations).values({
    id,
    groupId: membership.groupId,
    email: person.email,
    participantId: data.participantId,
    participantName: person.name,
    tokenHash,
    createdBy: data.principal.userId,
    expiresAt,
  })
  await recordGroupEvent(tx, { groupId: membership.groupId, type: 'update_group', principal: data.principal, data: 'Private expense invitation renewed' })
  return {
    groupId: membership.groupId,
    id,
    email: person.email,
    participantId: data.participantId,
    participantName: person.name,
    expiresAt: expiresAt.toISOString(),
    url: new URL(`/invite/${secret}`, data.baseUrl).href,
  }
}
