// Ungrouped (private) expenses. Each one gets its own private context: a
// hidden group whose ID is the expense ID and whose people never change. Only
// those people can see it, and repayments inside it settle only that expense.
// Ported from the current app's src/lib/ungrouped-expenses.ts and
// src/lib/ungrouped-access.ts; the write rules are in private-context.ts.
import { and, eq } from 'drizzle-orm'
import { expenses, groups, memberships, participants, privateContexts, privatePeople } from '../../db/schema/app'
import { Conflict, Forbidden, Invalid, type PrivatePerson as PrivatePersonSchema } from '../shared/api'
import { PEOPLE_RULE, type ExpenseDraft } from '../shared/expense-rules'
import { INVITED_PERSON_PROBLEM, invitedPerson, normalizeEmail, participantNameOf } from '../shared/groups'
import { LIMITS, participantLimitMessage } from '../shared/limits'
import { requireMember, type Principal } from './core/access'
import { groupSnapshot, PRIVATE_CONTEXT_TEXT, PRIVATE_INVITATION_RENEWED, recordGroupEvent } from './activity'
import type { Db } from './core/db'
import { createInvitation, revokeInvitations } from './invitations'
import { createExpense } from './ledger'
import { contacts } from './people'

export type PrivatePerson = typeof PrivatePersonSchema.Type

/**
 * Creates an ungrouped expense with two or more people: existing contacts by
 * account, or new people by exact email, who get a private link. The caller
 * must be one of the people. The private context and its people are written
 * first, so the expense write checks the private rules (private-context.ts):
 * the people must be exactly the payers and the people who share the cost.
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
  if (data.people.length > LIMITS.participantsPerGroup) throw new Invalid({ message: participantLimitMessage, field: 'people' })
  const people = data.people.map((person) => {
    if (person.kind === 'account') {
      const account = known.find((c) => c.id === person.userId)
      if (!account) throw new Invalid({ message: 'Choose an existing contact or invite someone by email.', field: 'people' })
      return { localId: person.id, name: participantNameOf(account.name), email: normalizeEmail(account.email), userId: account.id as string | null }
    }
    const invited = invitedPerson(person)
    if (!invited) throw new Invalid({ message: INVITED_PERSON_PROBLEM, field: 'people' })
    const { name, email } = invited
    // An email that belongs to a known contact links that account; nobody needs an invitation then.
    const account = known.find((c) => normalizeEmail(c.email) === email)
    return { localId: person.id, name: account ? participantNameOf(account.name) : name, email, userId: account?.id ?? null }
  })
  // A common prefix keeps the people's local order and makes reusable labels ("me", "friend") unique.
  const stored = people.map((p) => ({ ...p, id: `${data.expenseId}_${p.localId}` }))
  if (
    !stored.some((p) => p.userId === data.principal.userId) ||
    new Set(stored.map((p) => p.localId)).size !== stored.length ||
    new Set(stored.map((p) => p.email)).size !== stored.length
  )
    throw new Invalid({ message: PEOPLE_RULE, field: 'people' })

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
  // The expense row follows; its reference is checked at commit (migration 0015).
  await tx.insert(privateContexts).values({ groupId, expenseId: data.expenseId })
  await tx.insert(privatePeople).values(stored.map((p) => ({ participantId: p.id, groupId, email: p.email })))
  await recordGroupEvent(tx, {
    groupId,
    type: 'create_group',
    principal: data.principal,
    data: PRIVATE_CONTEXT_TEXT,
    snapshot: groupSnapshot({ group: { ...group, information: '' }, participants: stored }),
  })
  const toStored = new Map(stored.map((p) => [p.localId, p.id]))
  const local = (id: string) => toStored.get(id) ?? id
  const created = await createExpense(tx, {
    principal: data.principal,
    groupId,
    expenseId: data.expenseId,
    idempotencyKey: data.idempotencyKey,
    expense: {
      ...data.expense,
      payers: data.expense.payers.map((p) => ({ ...p, participantId: local(p.participantId) })),
      shares: data.expense.shares.map((s) => ({ ...s, participantId: local(s.participantId) })),
    },
  })

  const links = []
  for (const person of stored.filter((p) => !p.userId)) {
    const invitation = await createInvitation(tx, {
      groupId,
      email: person.email,
      participantId: person.id,
      participantName: person.name,
      createdBy: data.principal.userId,
      baseUrl: data.baseUrl,
    })
    links.push({ email: invitation.email, url: invitation.url, expiresAt: invitation.expiresAt })
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
  const membership = await requireMember(tx, { principal: data.principal, groupId: data.groupId })
  const { groupId } = membership
  const [person] = await tx
    .select({ email: privatePeople.email, name: participants.name, joined: memberships.userId })
    .from(privatePeople)
    .innerJoin(participants, eq(participants.id, privatePeople.participantId))
    .leftJoin(memberships, and(eq(memberships.groupId, privatePeople.groupId), eq(memberships.participantId, privatePeople.participantId)))
    .where(and(eq(privatePeople.participantId, data.participantId), eq(privatePeople.groupId, groupId)))
  if (membership.role !== 'admin' || !person) throw new Forbidden({ message: 'Only the expense creator can reissue its original invitations.' })
  if (person.joined) throw new Invalid({ message: 'This person has already joined.', field: 'participantId', reason: 'state' })
  await revokeInvitations(tx, { groupId, participantId: data.participantId })
  const invitation = await createInvitation(tx, {
    groupId,
    email: person.email,
    participantId: data.participantId,
    participantName: person.name,
    createdBy: data.principal.userId,
    baseUrl: data.baseUrl,
  })
  await recordGroupEvent(tx, { groupId, type: 'update_group', principal: data.principal, data: PRIVATE_INVITATION_RENEWED })
  return { groupId, ...invitation }
}
