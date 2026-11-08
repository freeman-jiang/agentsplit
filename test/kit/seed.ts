// Synthetic groups and private contexts, written as the app writes them. The
// database tests, the end-to-end fixtures and scripts/seed-synthetic.ts share them.
import { eq } from 'drizzle-orm'
import { groups } from '../../db/schema/app'
import { user } from '../../db/schema/auth'
import type { Principal } from '../../src/server/core/access'
import type { Db } from '../../src/server/core/db'
import { writeNewGroup } from '../../src/server/groups'
import { createUngroupedExpense } from '../../src/server/ungrouped'
import type { CurrencyCode } from '../../src/shared/currencies'
import type { Role } from '../../src/shared/vocabulary'
import { draft } from './drafts'
import { principal, userRows } from './people'

/** An account's membership: its participant (null while it is not bound) and its role. */
export type Member = { readonly userId: string; readonly participantId: string | null; readonly role: Role }

/**
 * A named group at revision 1, written by writeNewGroup as createGroup writes
 * it, with fixed IDs: the group, its participants in the given order, the
 * memberships, and the create_group event of `creator`, its first member and
 * an admin. The member accounts must exist. A second run changes nothing.
 */
export async function seedGroup(
  db: Db,
  data: {
    groupId: string
    slug: string | null
    name: string
    currency?: CurrencyCode
    people: readonly { id: string; name: string }[]
    creator: Principal
    members: readonly [Member & { role: 'admin' }, ...Member[]]
  },
): Promise<void> {
  const [existing] = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, data.groupId))
  if (existing) return
  await writeNewGroup(db, {
    group: { id: data.groupId, slug: data.slug, name: data.name, information: '', defaultCurrency: data.currency ?? 'USD' },
    people: data.people,
    members: data.members,
    creator: data.creator,
  })
}

/** A participant, and the verified account bound to it when `userId` is set. */
export type Person = { readonly id: string; readonly name: string; readonly userId?: string }

export type Household = { readonly groupId: string; readonly slug: string; readonly owner: Principal; readonly people: readonly Person[] }

/**
 * A named group with `people` (seedGroup). The first person is the owner: an
 * admin with an account. The others with a `userId` are members.
 */
export async function seedHousehold(db: Db, data: { groupId: string; slug: string; name: string; people: readonly [Person & { userId: string }, ...Person[]] }): Promise<Household> {
  const [first, ...rest] = data.people
  const owner = principal(first.userId, { name: first.name })
  const accounts = data.people.flatMap((p) => (p.userId ? [principal(p.userId, { name: p.name })] : []))
  await db.insert(user).values(userRows(accounts, { verified: true })).onConflictDoNothing()
  await seedGroup(db, {
    groupId: data.groupId,
    slug: data.slug,
    name: data.name,
    people: data.people,
    creator: owner,
    members: [
      { userId: first.userId, participantId: first.id, role: 'admin' },
      ...rest.flatMap((p) => (p.userId ? [{ userId: p.userId, participantId: p.id, role: 'member' as const }] : [])),
    ],
  })
  return { groupId: data.groupId, slug: data.slug, owner, people: data.people }
}

/**
 * A real private context: one ungrouped expense of 10.00 between `owner` and
 * an invited friend, paid by the owner and split evenly. Returns its group ID.
 */
export async function createPrivateContext(tx: Db, data: { owner: Principal; expenseId: string; baseUrl: string }): Promise<string> {
  const result = await createUngroupedExpense(tx, {
    principal: data.owner,
    baseUrl: data.baseUrl,
    expenseId: data.expenseId,
    idempotencyKey: `key-${data.expenseId}`,
    people: [
      { kind: 'account', id: 'me', userId: data.owner.userId },
      { kind: 'email', id: 'friend', name: 'Friend', email: `friend-${data.expenseId}@example.com` },
    ],
    expense: draft({ payer: 'me', people: ['me', 'friend'], title: 'Private dinner', amount: '10.00', expenseDate: '2026-11-02' }),
  })
  return result.groupId
}
