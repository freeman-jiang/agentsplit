// Synthetic groups and private contexts, written as the app writes them. The
// database tests, the end-to-end fixtures and scripts/seed-synthetic.ts share them.
import { groups, memberships, participants } from '../../db/schema/app'
import { user } from '../../db/schema/auth'
import type { Principal } from '../../src/server/core/access'
import type { Db } from '../../src/server/core/db'
import { createUngroupedExpense } from '../../src/server/ungrouped'
import { draft } from './drafts'
import { principal } from './people'

/** A participant, and the verified account bound to it when `userId` is set. */
export type Person = { readonly id: string; readonly name: string; readonly userId?: string }

export type Household = { readonly groupId: string; readonly slug: string; readonly owner: Principal; readonly people: readonly Person[] }

/**
 * A named group with `people`. The first person is the owner: an admin with
 * an account. The others with a `userId` are members. A second run changes
 * nothing.
 */
export async function seedHousehold(db: Db, data: { groupId: string; slug: string; name: string; people: readonly [Person & { userId: string }, ...Person[]] }): Promise<Household> {
  const { groupId, people } = data
  const accounts = people.flatMap((p) => (p.userId ? [{ ...p, userId: p.userId }] : []))
  const now = new Date()
  await db
    .insert(user)
    .values(accounts.map((p) => ({ id: p.userId, name: p.name, email: `${p.userId}@example.com`, emailVerified: true, createdAt: now, updatedAt: now })))
    .onConflictDoNothing()
  await db.insert(groups).values({ id: groupId, kind: 'named', slug: data.slug, name: data.name, defaultCurrency: 'USD' }).onConflictDoNothing()
  await db.insert(participants).values(people.map((p) => ({ id: p.id, groupId, name: p.name }))).onConflictDoNothing()
  await db
    .insert(memberships)
    .values(accounts.map((p, i) => ({ userId: p.userId, groupId, role: i === 0 ? ('admin' as const) : ('member' as const), participantId: p.id })))
    .onConflictDoNothing()
  const [owner] = people
  return { groupId, slug: data.slug, owner: principal(owner.userId, { name: owner.name }), people }
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
