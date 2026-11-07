// Groups and access against a real database: settings, people, slugs,
// invitations and membership changes. Item IDs refer to docs/v2/PARITY.md.
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { activities, groups, invitations, memberships } from '../../db/schema/app'
import { user } from '../../db/schema/auth'
import { eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { accountBalances, listBalances } from '~/server/balances'
import { makeDb, RequestDb, transaction, type Db } from '~/server/db'
import {
  changeAccess,
  createGroup,
  getGroupDetails,
  invitationTokenHash,
  listDirectory,
  previewInvitation,
  updateGroup,
} from '~/server/groups'
import { exportJson } from '~/server/export'
import { listFeed } from '~/server/feed'
import { listActivities } from '~/server/history'
import { createExpense, getGroup } from '~/server/ledger'
import { requireMember, type Principal } from '~/server/access'
import { statsOverview } from '~/server/stats'
import { createUngroupedExpense } from '~/server/ungrouped'
import { resetTestDatabase } from './setup'

// These tests create many groups as one account; the fair-use cap has its own test (test/db/limits.test.ts).
vi.mock('~/shared/limits', async (original) => {
  const limits = await original<typeof import('~/shared/limits')>()
  return { ...limits, LIMITS: { ...limits.LIMITS, groupsCreated: 1000 } }
})

let pool: Pool
const BASE = 'https://agentsplit.test'

/** A real private expense context: the owner and one invited friend, the owner paid 10.00 evenly. */
async function privateContext(owner: Principal, id: string) {
  const result = await tx((db) =>
    createUngroupedExpense(db, {
      principal: owner,
      baseUrl: BASE,
      expenseId: id,
      idempotencyKey: `key-${id}`,
      people: [
        { kind: 'account', id: 'me', userId: owner.userId },
        { kind: 'email', id: 'friend', name: 'Friend', email: `friend-${id}@example.com` },
      ],
      expense: {
        kind: 'expense',
        title: 'Private dinner',
        vendor: null,
        notes: '',
        categoryId: 0,
        expenseDate: '2026-11-02',
        currency: 'USD',
        amount: '10.00',
        payers: [{ participantId: 'me', amount: '10.00' }],
        splitMode: 'evenly',
        shares: [{ participantId: 'me', weight: '1' }, { participantId: 'friend', weight: '1' }],
        recurrence: 'none',
      },
    }),
  )
  return result.groupId
}
const person = (id: string, name: string): Principal => ({ userId: id, name, email: `${id}@example.com`, source: 'web', agentKeyId: null })
const alice = person('alice', 'Alice Admin')
const bob = person('bob', 'Bob')
const cara = person('cara', 'Cara')
const mallory = person('mallory', 'Mallory')

let n = 0
const key = () => `key-${++n}-${Math.random().toString(36).slice(2)}`

/** Runs `work` in a SERIALIZABLE transaction and retries serialization failures, as the server does. */
async function tx<A>(work: (db: Db) => Promise<A>): Promise<A> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect()
    try {
      return await makeDb(client).transaction(work, { isolationLevel: 'serializable' })
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code
      if (attempt < 4 && (code === '40001' || code === '40P01')) continue
      throw error
    } finally {
      client.release()
    }
  }
}

/** Runs `work` through the server's own transaction(), with its retries. */
async function serverTx<A>(work: (db: Db) => Promise<A>): Promise<A> {
  const client = await pool.connect()
  try {
    return await Effect.runPromise(transaction(work).pipe(Effect.provideService(RequestDb, makeDb(client))))
  } finally {
    client.release()
  }
}

const create = (principal: Principal, group: Partial<Parameters<typeof createGroup>[1]['group']> = {}, groupId: string | null = null) =>
  tx((db) =>
    createGroup(db, {
      principal,
      groupId,
      idempotencyKey: key(),
      group: { name: 'Home', slug: null, information: '', defaultCurrency: 'USD', participants: [], ...group },
    }),
  )
const details = (principal: Principal, group: string) => tx((db) => getGroupDetails(db, { principal, group }))
const update = (principal: Principal, group: string, expectedRevision: number, changes: Parameters<typeof updateGroup>[1]['changes']) =>
  tx((db) => updateGroup(db, { principal, group, expectedRevision, idempotencyKey: key(), changes }))
const access = (principal: Principal, request: Parameters<typeof changeAccess>[1]['request']) =>
  tx((db) => changeAccess(db, { principal, baseUrl: BASE, idempotencyKey: key(), request }))

/** Creates a group with Bob as a named participant and invites and joins Bob. */
async function groupWithBob(slug: string | null = null) {
  const g = await create(alice, { name: 'Shared', slug, participants: ['Bob placeholder', 'Dana'] })
  const d = await details(alice, g.id)
  const bobPerson = d.people.find((p) => p.name === 'Bob placeholder')!
  const invite = await access(alice, { action: 'invite', groupId: g.id, email: ' BOB@example.com ', participantId: bobPerson.id })
  await access(bob, { action: 'join', shareUrl: invite.invitation!.url! })
  return { group: g, bobPerson, invite }
}

beforeAll(async () => {
  pool = await resetTestDatabase()
  const now = new Date()
  await tx((db) =>
    db.insert(user).values(
      [alice, bob, cara, mallory].map((p) => ({ id: p.userId, name: p.name, email: p.email, emailVerified: true, createdAt: now, updatedAt: now })),
    ),
  )
})
afterAll(async () => {
  await pool.end()
})

describe('creating groups', () => {
  it('adds the creator as the bound admin, starts at revision 1 and logs the creation (P-GROUP-27, -28, -29, -39, -40)', async () => {
    const g = await create(alice, { name: 'Flat' })
    expect(g.revision).toBe(1)
    const d = await details(alice, g.id)
    expect(d.role).toBe('admin')
    expect(d.people).toHaveLength(1)
    expect(d.people[0]).toMatchObject({ name: 'Alice Admin', status: 'joined', role: 'admin', email: 'alice@example.com', reserved: true })
    expect(d.participantId).toBe(d.people[0]!.id)
    const log = await tx((db) => db.select().from(activities).where(eq(activities.groupId, g.id)))
    expect(log).toEqual([expect.objectContaining({ type: 'create_group', data: 'Flat', groupRevision: 1, actorUserId: 'alice' })])
    expect(log[0]!.snapshot).toMatchObject({ schemaVersion: 2, kind: 'group', group: { name: 'Flat', revision: 1 } })
  })

  it('names the creator "Member" when the account name is empty, and cuts long names to 50 characters (P-GROUP-27, -30)', async () => {
    const blank = await create({ ...cara, name: '   ' })
    expect((await details(cara, blank.id)).people[0]?.name).toBe('Cara') // the verified account name is the display name
    const [row] = await tx((db) => db.execute<{ name: string }>(sql`SELECT name FROM participants WHERE group_id = ${blank.id}`).then((r) => r.rows))
    expect(row?.name).toBe('Member')
    const long = await create({ ...cara, name: 'x'.repeat(80) })
    const [p] = await tx((db) => db.execute<{ name: string }>(sql`SELECT name FROM participants WHERE group_id = ${long.id}`).then((r) => r.rows))
    expect(p?.name).toHaveLength(50)
  })

  it('refuses duplicate participant names, including the creator name (P-GROUP-31)', async () => {
    await expect(create(alice, { participants: ['Alice Admin'] })).rejects.toMatchObject({ _tag: 'Invalid', message: expect.stringContaining('distinct name') })
    await expect(create(alice, { participants: ['Kim', 'Kim'] })).rejects.toMatchObject({ _tag: 'Invalid' })
  })

  it('accepts a caller-chosen ID once (P-GROUP-38)', async () => {
    await create(alice, {}, 'abcdefghijklmnopqrstu')
    await expect(create(alice, {}, 'abcdefghijklmnopqrstu')).rejects.toMatchObject({ _tag: 'Invalid', field: 'groupId' })
  })

  it('returns the stored result when a create is retried with the same key', async () => {
    const k = key()
    const input = { name: 'Retry', slug: null, information: '', defaultCurrency: 'USD' as const, participants: [] }
    const first = await tx((db) => createGroup(db, { principal: alice, groupId: null, idempotencyKey: k, group: input }))
    const again = await tx((db) => createGroup(db, { principal: alice, groupId: null, idempotencyKey: k, group: input }))
    expect(again).toEqual(first)
  })
})

describe('slugs', () => {
  it('normalizes, validates and reserves slugs (P-GROUP-92, -93, -94)', async () => {
    const g = await create(alice, { slug: '  My-Flat ' })
    expect(g.slug).toBe('my-flat')
    await expect(create(alice, { slug: 'ab' })).rejects.toMatchObject({ _tag: 'Invalid', field: 'slug' })
    await expect(create(alice, { slug: '-flat' })).rejects.toMatchObject({ _tag: 'Invalid', field: 'slug' })
    await expect(create(alice, { slug: 'Settings' })).rejects.toMatchObject({ _tag: 'Invalid', message: 'This URL is reserved.' })
  })

  it('refuses a slug in use by another group (P-GROUP-95)', async () => {
    await create(alice, { slug: 'taken-slug' })
    await expect(create(bob, { slug: 'taken-slug' })).rejects.toMatchObject({ _tag: 'Invalid', message: 'This group URL is already in use.' })
  })

  it('lets exactly one of two concurrent creates claim a slug (P-GROUP-96)', async () => {
    const claim = (principal: Principal) =>
      serverTx((db) =>
        createGroup(db, { principal, groupId: null, idempotencyKey: key(), group: { name: 'Race', slug: 'race-slug', information: '', defaultCurrency: 'USD', participants: [] } }),
      )
    const results = await Promise.allSettled([claim(alice), claim(bob)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { _tag: 'Invalid', field: 'slug' } })
  })

  it('resolves slugs case-insensitively, redirects old slugs and removes slugs (P-GROUP-97, -105, -106)', async () => {
    const g = await create(alice, { slug: 'macademia-test' })
    expect((await getGroupBy(alice, 'Macademia-Test')).id).toBe(g.id)
    const renamed = await update(alice, g.id, 1, { slug: 'new-home' })
    expect(renamed).toEqual({ id: g.id, slug: 'new-home', revision: 2 })
    // The old slug still opens the group, and the response names the current slug.
    expect(await getGroupBy(alice, 'macademia-test')).toMatchObject({ id: g.id, slug: 'new-home' })
    const removed = await update(alice, 'new-home', 2, { slug: '' })
    expect(removed.slug).toBeNull()
    expect((await getGroupBy(alice, 'new-home')).id).toBe(g.id)
    // A current slug wins over another group's old one.
    const other = await create(alice, { slug: 'macademia-test' })
    expect((await getGroupBy(alice, 'macademia-test')).id).toBe(other.id)
  })

  it('resolves a retired, mixed-case slug the same way in every read', async () => {
    const g = await create(alice, { slug: 'old-flat', participants: ['Kim'] })
    const [me, kim] = (await details(alice, g.id)).people
    await tx((db) =>
      createExpense(db, {
        principal: alice,
        group: g.id,
        expenseId: `exp-${g.id}`,
        idempotencyKey: key(),
        expense: {
          kind: 'expense',
          title: 'Dinner',
          vendor: null,
          notes: '',
          categoryId: 0,
          expenseDate: '2026-11-01',
          currency: 'USD',
          amount: '10.00',
          payers: [{ participantId: me!.id, amount: '10.00' }],
          splitMode: 'evenly',
          shares: [{ participantId: me!.id, weight: '1' }, { participantId: kim!.id, weight: '1' }],
          recurrence: 'none',
        },
      }),
    )
    await update(alice, g.id, 1, { slug: 'new-flat' })
    const ref = 'OLD-Flat'
    const activity = await tx((db) => listActivities(db, { principal: alice, group: ref }))
    expect(activity.groupId).toBe(g.id)
    expect((await tx((db) => statsOverview(db, { principal: alice, group: ref }))).total).toBe('10.00')
    expect(JSON.parse((await tx((db) => exportJson(db, { principal: alice, group: ref }))).content).id).toBe(g.id)
    expect((await tx((db) => listBalances(db, { principal: alice, group: ref }))).currencies).toHaveLength(1)
    expect((await tx((db) => listFeed(db, { principal: alice, filter: { groupId: ref }, cursor: null, limit: 10 }))).expenses).toHaveLength(1)
    expect((await tx((db) => accountBalances(db, { principal: alice, scope: [{ groupId: ref }] }))).balances).toMatchObject([{ groupId: g.id, amount: '5.00' }])
    await expect(tx((db) => statsOverview(db, { principal: mallory, group: ref }))).rejects.toMatchObject({ _tag: 'Forbidden' })
  })

  it('does not grant access through a slug (P-GROUP-103, P-ACCESS-09)', async () => {
    await create(alice, { slug: 'private-flat' })
    await expect(getGroupBy(mallory, 'private-flat')).rejects.toMatchObject({ _tag: 'Forbidden' })
    await expect(details(mallory, 'private-flat')).rejects.toMatchObject({ _tag: 'Forbidden' })
  })
})

const getGroupBy = (principal: Principal, ref: string) => tx((db) => getGroup(db, { principal, group: ref }))

describe('settings', () => {
  it('lets only admins change settings (P-GROUP-64)', async () => {
    const { group } = await groupWithBob()
    await expect(update(bob, group.id, 1, { name: 'Mine now' })).rejects.toMatchObject({ _tag: 'Forbidden', message: 'Only group admins can edit group settings' })
  })

  it('applies partial changes, bumps the revision and logs each change (P-GROUP-63, -67, -68, -75)', async () => {
    const g = await create(alice, { name: 'Before', information: 'Keep me' })
    const result = await update(alice, g.id, 1, { name: 'After', defaultCurrency: 'JPY' })
    expect(result.revision).toBe(2)
    const d = await details(alice, g.id)
    expect(d).toMatchObject({ name: 'After', information: 'Keep me', defaultCurrency: 'JPY', revision: 2 })
    const log = await tx((db) => db.select().from(activities).where(eq(activities.groupId, g.id)))
    expect(log.map((a) => [a.type, a.groupRevision])).toEqual([
      ['create_group', 1],
      ['update_group', 2],
    ])
  })

  it('leaves the revision alone for an empty change (P-GROUP-69)', async () => {
    const g = await create(alice)
    expect(await update(alice, g.id, 1, {})).toMatchObject({ revision: 1 })
  })

  it('refuses a stale revision (P-GROUP-66)', async () => {
    const g = await create(alice)
    await update(alice, g.id, 1, { name: 'One' })
    await expect(update(alice, g.id, 1, { name: 'Two' })).rejects.toMatchObject({ _tag: 'Conflict', currentRevision: 2 })
  })

  it('keeps existing expenses unchanged when the default currency changes (P-GROUP-63)', async () => {
    const g = await create(alice, { participants: ['Kim'] })
    const d = await details(alice, g.id)
    const [me, kim] = d.people
    await tx((db) =>
      createExpense(db, {
        principal: alice,
        group: g.id,
        expenseId: `exp-${g.id}`,
        idempotencyKey: key(),
        expense: {
          kind: 'expense',
          title: 'Dinner',
          vendor: null,
          notes: '',
          categoryId: 0,
          expenseDate: '2026-11-01',
          currency: 'USD',
          amount: '10.00',
          payers: [{ participantId: me!.id, amount: '10.00' }],
          splitMode: 'evenly',
          shares: [{ participantId: me!.id, weight: '1' }, { participantId: kim!.id, weight: '1' }],
          recurrence: 'none',
        },
      }),
    )
    await update(alice, g.id, 1, { defaultCurrency: 'EUR' })
    const after = await getGroupBy(alice, g.id)
    expect(after.defaultCurrency).toBe('EUR')
    const { currencies } = await tx((db) => listBalances(db, { principal: alice, group: g.id }))
    expect(currencies.find((c) => c.currency === 'USD')?.balances.map((b) => b.net).sort()).toEqual(['-5.00', '5.00'])
  })

  it('refuses a group edit without its activity, at the database (P-DB-73)', async () => {
    const g = await create(alice)
    const refused = { cause: { code: '23514' } }
    await expect(tx((db) => db.update(groups).set({ name: 'Sneaky', revision: 2 }).where(eq(groups.id, g.id)))).rejects.toMatchObject(refused)
    await expect(tx((db) => db.update(groups).set({ name: 'Sneaky' }).where(eq(groups.id, g.id)))).rejects.toMatchObject(refused)
  })
})

describe('people', () => {
  it('adds, renames and removes unreferenced people (P-GROUP-82, -83, -84)', async () => {
    const g = await create(alice, { participants: ['Kim'] })
    const [me, kim] = (await details(alice, g.id)).people
    await update(alice, g.id, 1, { participants: [{ id: me!.id, name: me!.name }, { id: kim!.id, name: 'Kimberly' }, { name: 'Lee' }] })
    const after = await details(alice, g.id)
    expect(after.people.map((p) => p.name)).toEqual(['Alice Admin', 'Kimberly', 'Lee'])
    await update(alice, g.id, 2, { participants: [{ id: me!.id, name: me!.name }, { id: kim!.id, name: 'Kimberly' }] })
    expect((await details(alice, g.id)).people.map((p) => p.name)).toEqual(['Alice Admin', 'Kimberly'])
  })

  it('refuses to remove a person in an expense with a friendly message (P-GROUP-76)', async () => {
    const g = await create(alice, { participants: ['Kim'] })
    const [me, kim] = (await details(alice, g.id)).people
    await tx((db) =>
      createExpense(db, {
        principal: alice,
        group: g.id,
        expenseId: `exp2-${g.id}`,
        idempotencyKey: key(),
        expense: {
          kind: 'expense',
          title: 'Taxi',
          vendor: null,
          notes: '',
          categoryId: 0,
          expenseDate: '2026-11-02',
          currency: 'USD',
          amount: '8.00',
          payers: [{ participantId: me!.id, amount: '8.00' }],
          splitMode: 'evenly',
          shares: [{ participantId: kim!.id, weight: '1' }],
          recurrence: 'none',
        },
      }),
    )
    expect((await details(alice, g.id)).people.find((p) => p.id === kim!.id)?.inExpenses).toBe(true)
    await expect(update(alice, g.id, 1, { participants: [{ id: me!.id, name: me!.name }] })).rejects.toMatchObject({
      _tag: 'Invalid',
      message: 'Kim is part of expenses, so they cannot be removed.',
    })
  })

  it('refuses renaming or removing bound or invited people (P-GROUP-71)', async () => {
    const { group, bobPerson } = await groupWithBob()
    const people = (await details(alice, group.id)).people
    const renamed = people.map((p) => ({ id: p.id, name: p.id === bobPerson.id ? 'Robert' : p.name }))
    await expect(update(alice, group.id, 1, { participants: renamed })).rejects.toMatchObject({ message: expect.stringContaining('cannot be renamed or removed') })
  })

  it('refuses IDs from another group and new names that repeat (P-GROUP-70, -72)', async () => {
    const a = await create(alice, { participants: ['Kim'] })
    const b = await create(alice, { participants: ['Lee'] })
    const lee = (await details(alice, b.id)).people[1]!
    const people = (await details(alice, a.id)).people.map((p) => ({ id: p.id, name: p.name }))
    await expect(update(alice, a.id, 1, { participants: [...people, { id: lee.id, name: 'Lee' }] })).rejects.toMatchObject({
      message: expect.stringContaining('must belong to this group'),
    })
    await expect(update(alice, a.id, 1, { participants: [...people, { name: 'Kim' }] })).rejects.toMatchObject({ message: expect.stringContaining('already called Kim') })
  })

  it('refuses settings edits of a private expense context (P-GROUP-74)', async () => {
    const context = await privateContext(alice, 'private-settings')
    const [row] = await tx((db) => db.select({ revision: groups.revision }).from(groups).where(eq(groups.id, context)))
    await expect(update(alice, context, row?.revision ?? 0, { name: 'Renamed' })).rejects.toMatchObject({ message: expect.stringContaining('A private expense is not a named group') })
  })
})

describe('group history', () => {
  // The groups area writes group snapshots and the history area reads them; this
  // crosses both, because each area's own tests cannot see a shape mismatch.
  it('lists a group edit in the Log with the snapshot the history reader accepts', async () => {
    const group = await create(alice, { name: 'Logged' })
    await update(alice, group.id, 1, { name: 'Logged renamed' })
    const page = await tx((db) => listActivities(db, { principal: alice, group: group.id }))
    const json = JSON.stringify(page)
    expect(json).toContain('Logged renamed')
    expect(json).toContain('"currency":"USD"')
  })
})

describe('directory', () => {
  it('lists named groups newest first, with counts and the caller net per currency (P-GROUP-04, -05, -06, -11, P-BAL-102)', async () => {
    const owner = person('dir-owner', 'Dir Owner')
    const other = person('dir-other', 'Dir Other')
    await tx((db) =>
      db.insert(user).values([owner, other].map((p) => ({ id: p.userId, name: p.name, email: p.email, emailVerified: true, createdAt: new Date(), updatedAt: new Date() }))),
    )
    const first = await create(owner, { name: 'First', participants: ['Kim'] })
    await create(owner, { name: 'Second' })
    await create(other, { name: 'Not mine' })
    // A private expense context: hidden from the directory, but part of the account total.
    await privateContext(owner, 'dir-private')
    const [me, kim] = (await details(owner, first.id)).people
    await tx((db) =>
      createExpense(db, {
        principal: owner,
        group: first.id,
        expenseId: `exp-dir`,
        idempotencyKey: key(),
        expense: {
          kind: 'expense',
          title: 'Rent',
          vendor: null,
          notes: '',
          categoryId: 0,
          expenseDate: '2026-11-01',
          currency: 'USD',
          amount: '100.00',
          payers: [{ participantId: me!.id, amount: '100.00' }],
          splitMode: 'evenly',
          shares: [{ participantId: me!.id, weight: '1' }, { participantId: kim!.id, weight: '1' }],
          recurrence: 'none',
        },
      }),
    )
    const dir = await tx((db) => listDirectory(db, { principal: owner, offset: 0 }))
    expect(dir.groups.map((g) => g.name)).toEqual(['Second', 'First'])
    expect(dir.groups[1]).toMatchObject({ id: first.id, participantCount: 2 })
    // 50.00 from the named group and 5.00 from the private expense.
    expect(dir.totals).toEqual([{ currency: 'USD', net: '55.00' }])
    expect(dir.unboundGroupCount).toBe(0)
    // The directory card and the dashboard card show the same total (P-BAL-106).
    const account = await tx((db) => accountBalances(db, { principal: owner }))
    expect(account.totals.map((t) => ({ currency: t.currency, net: t.amount }))).toEqual(dir.totals)
    expect(account.unboundGroupIds).toHaveLength(dir.unboundGroupCount)
    expect(dir.nextOffset).toBeNull()
  })
})

describe('invitations', () => {
  it('creates an email-bound invitation with a hashed 43-character token that expires in 7 days (P-ACCESS-11..15)', async () => {
    const { invite, group } = await groupWithBob()
    const inv = invite.invitation!
    expect(inv.email).toBe('bob@example.com')
    const token = inv.url!.split('/invite/')[1]!
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(inv.url).toBe(`${BASE}/invite/${token}`)
    const [row] = await tx((db) => db.select().from(invitations).where(eq(invitations.id, inv.id)))
    expect(row?.tokenHash).toBe(await invitationTokenHash(token))
    expect(JSON.stringify(row)).not.toContain(token)
    const days = (row!.expiresAt.getTime() - row!.createdAt.getTime()) / 86_400_000
    expect(days).toBeCloseTo(7, 2)
    // The idempotency record must not keep the secret either.
    const stored = await tx((db) => db.execute(sql`SELECT response::text AS r FROM idempotency_keys`).then((r) => r.rows.map((x) => String(x['r']))))
    expect(stored.some((r) => r.includes(token))).toBe(false)
    // The log says an invitation was created, without the email (P-ACCESS-30).
    const log = await tx((db) => db.select().from(activities).where(eq(activities.groupId, group.id)))
    expect(log.map((a) => a.data ?? '').join('\n')).not.toContain('bob@example.com')
    expect(log.map((a) => a.type)).toEqual(['create_group', 'update_group', 'join_group'])
  })

  it('binds the joiner to the invited participant as a member (P-ACCESS-41, -49, -51)', async () => {
    const { group, bobPerson } = await groupWithBob('bob-flat')
    const m = await tx((db) => requireMember(db, { principal: bob, group: 'bob-flat' }))
    expect(m).toEqual({ groupId: group.id, role: 'member', participantId: bobPerson.id })
    const d = await details(bob, group.id)
    expect(d.people.find((p) => p.id === bobPerson.id)).toMatchObject({ name: 'Bob', status: 'joined', email: 'bob@example.com' })
    expect(d.invitations).toEqual([]) // members get no invitation list (P-ACCESS-29)
  })

  it('lets only admins invite (P-ACCESS-10)', async () => {
    const { group } = await groupWithBob()
    const dana = (await details(alice, group.id)).people.find((p) => p.name === 'Dana')!
    await expect(access(bob, { action: 'invite', groupId: group.id, email: 'dana@example.com', participantId: dana.id })).rejects.toMatchObject({
      _tag: 'Forbidden',
      message: 'Only group admins can manage access',
    })
  })

  it('refuses a second pending invitation, an existing member and a foreign participant (P-ACCESS-11, -16, -18)', async () => {
    const { group, bobPerson } = await groupWithBob()
    const dana = (await details(alice, group.id)).people.find((p) => p.name === 'Dana')!
    await access(alice, { action: 'invite', groupId: group.id, email: 'dana@example.com', participantId: dana.id })
    await expect(access(alice, { action: 'invite', groupId: group.id, email: 'other@example.com', participantId: dana.id })).rejects.toMatchObject({
      message: expect.stringContaining('already reserves'),
    })
    await expect(access(alice, { action: 'invite', groupId: group.id, email: 'bob@example.com', participantId: bobPerson.id })).rejects.toMatchObject({
      message: expect.stringContaining('already a member'),
    })
    const elsewhere = await create(alice, { participants: ['Zed'] })
    const zed = (await details(alice, elsewhere.id)).people[1]!
    await expect(access(alice, { action: 'invite', groupId: group.id, email: 'zed@example.com', participantId: zed.id })).rejects.toMatchObject({
      message: 'Choose a participant in this group.',
    })
  })

  it('lets one of two simultaneous invitations for a participant succeed (P-ACCESS-17)', async () => {
    const g = await create(alice, { participants: ['Kim'] })
    const kim = (await details(alice, g.id)).people[1]!
    const results = await Promise.allSettled([
      access(alice, { action: 'invite', groupId: g.id, email: 'kim1@example.com', participantId: kim.id }),
      access(alice, { action: 'invite', groupId: g.id, email: 'kim2@example.com', participantId: kim.id }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('lists pending invitations for admins and hides revoked and expired ones (P-ACCESS-25, -26, -28)', async () => {
    const g = await create(alice, { participants: ['Kim', 'Lee'] })
    const [, kim, lee] = (await details(alice, g.id)).people
    const k = await access(alice, { action: 'invite', groupId: g.id, email: 'kim@example.com', participantId: kim!.id })
    await access(alice, { action: 'invite', groupId: g.id, email: 'lee@example.com', participantId: lee!.id })
    let d = await details(alice, g.id)
    expect(d.invitations.map((i) => i.email).sort()).toEqual(['kim@example.com', 'lee@example.com'])
    expect(d.people.find((p) => p.id === kim!.id)).toMatchObject({ status: 'invited', email: 'kim@example.com' })
    await access(alice, { action: 'revoke_invitation', groupId: g.id, invitationId: k.invitation!.id })
    await expect(access(alice, { action: 'revoke_invitation', groupId: g.id, invitationId: k.invitation!.id })).rejects.toMatchObject({ _tag: 'NotFound' })
    await tx((db) => db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.email, 'lee@example.com')))
    d = await details(alice, g.id)
    expect(d.invitations).toEqual([])
    expect(d.people.find((p) => p.id === kim!.id)?.status).toBe('none')
  })

  it('refuses links that are not invitations from this app, and unknown tokens (P-ACCESS-42, -43)', async () => {
    const g = await create(alice, { slug: 'join-me' })
    for (const shareUrl of [`${BASE}/join-me`, `https://evil.test/invite/${'a'.repeat(43)}`, `https://u:p@agentsplit.test/invite/${'a'.repeat(43)}`, 'not a url'])
      await expect(access(bob, { action: 'join', shareUrl })).rejects.toMatchObject({ _tag: 'Invalid', field: 'shareUrl' })
    await expect(access(bob, { action: 'join', shareUrl: `${BASE}/invite/${'a'.repeat(43)}` })).rejects.toMatchObject({ _tag: 'NotFound' })
    await expect(tx((db) => requireMember(db, { principal: bob, group: g.id }))).rejects.toMatchObject({ _tag: 'Forbidden' })
  })

  it('refuses the wrong email, revoked and expired invitations (P-ACCESS-38, -44)', async () => {
    const g = await create(alice, { participants: ['Kim'] })
    const kim = (await details(alice, g.id)).people[1]!
    const inv = await access(alice, { action: 'invite', groupId: g.id, email: 'cara@example.com', participantId: kim.id })
    const url = inv.invitation!.url!
    const token = url.split('/invite/')[1]!
    expect(await tx((db) => previewInvitation(db, { principal: mallory, token }))).toEqual({ status: 'unavailable' })
    await expect(access(mallory, { action: 'join', shareUrl: url })).rejects.toMatchObject({ _tag: 'Forbidden' })
    expect(await tx((db) => previewInvitation(db, { principal: cara, token }))).toEqual({ status: 'valid', kind: 'named', groupName: 'Home', participantName: 'Kim' })
    await tx((db) => db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, inv.invitation!.id)))
    expect(await tx((db) => previewInvitation(db, { principal: cara, token }))).toEqual({ status: 'unavailable' })
    await expect(access(cara, { action: 'join', shareUrl: url })).rejects.toMatchObject({ _tag: 'Forbidden' })
  })

  it('accepts a retry while still a member, but a used invitation cannot undo a removal (P-ACCESS-47, -48)', async () => {
    const { group, invite } = await groupWithBob()
    expect(await access(bob, { action: 'join', shareUrl: invite.invitation!.url! })).toMatchObject({ joined: true })
    await access(alice, { action: 'remove_member', groupId: group.id, userId: bob.userId })
    await expect(access(bob, { action: 'join', shareUrl: invite.invitation!.url! })).rejects.toMatchObject({ message: 'Invitation already used' })
  })

  it('returns the invitation without its URL to a retried request', async () => {
    const g = await create(alice, { participants: ['Kim'] })
    const kim = (await details(alice, g.id)).people[1]!
    const k = key()
    const request = { action: 'invite' as const, groupId: g.id, email: 'kim@example.com', participantId: kim.id }
    const first = await tx((db) => changeAccess(db, { principal: alice, baseUrl: BASE, idempotencyKey: k, request }))
    const again = await tx((db) => changeAccess(db, { principal: alice, baseUrl: BASE, idempotencyKey: k, request }))
    expect(first.invitation?.url).toMatch(/\/invite\//)
    expect(again.invitation).toEqual({ ...first.invitation, url: null })
  })
})

describe('roles, removal and leaving', () => {
  it('removes access at once and keeps the participant and expenses (P-ACCESS-08, -54, -56)', async () => {
    const { group, bobPerson } = await groupWithBob()
    await access(alice, { action: 'remove_member', groupId: group.id, userId: bob.userId })
    await expect(getGroupBy(bob, group.id)).rejects.toMatchObject({ _tag: 'Forbidden' })
    const d = await details(alice, group.id)
    expect(d.people.find((p) => p.id === bobPerson.id)).toMatchObject({ status: 'none', reserved: true })
    await expect(access(alice, { action: 'remove_member', groupId: group.id, userId: bob.userId })).rejects.toMatchObject({ _tag: 'NotFound' })
  })

  it('keeps the last admin (P-ACCESS-55) and lets roles change (P-ACCESS-53)', async () => {
    const { group } = await groupWithBob()
    await expect(access(alice, { action: 'leave', groupId: group.id })).rejects.toMatchObject({ message: expect.stringContaining('last admin') })
    await expect(access(alice, { action: 'set_role', groupId: group.id, userId: alice.userId, role: 'member' })).rejects.toMatchObject({
      message: expect.stringContaining('last admin'),
    })
    await access(alice, { action: 'set_role', groupId: group.id, userId: bob.userId, role: 'admin' })
    expect((await details(bob, group.id)).role).toBe('admin')
    expect(await access(alice, { action: 'leave', groupId: group.id })).toMatchObject({ joined: false })
    const log = await tx((db) => db.select().from(activities).where(eq(activities.groupId, group.id)))
    expect(log.at(-1)).toMatchObject({ type: 'leave_group', actorUserId: 'alice' })
  })

  it('lets any member leave and rejoin as the same participant (P-ACCESS-19, -50, -57)', async () => {
    const { group, bobPerson } = await groupWithBob()
    expect(await access(bob, { action: 'leave', groupId: group.id })).toMatchObject({ joined: false })
    // The participant stays tied to Bob's account, so nobody else can take it.
    await expect(access(alice, { action: 'invite', groupId: group.id, email: 'cara@example.com', participantId: bobPerson.id })).rejects.toMatchObject({
      message: 'That participant is already tied to another account.',
    })
    const again = await access(alice, { action: 'invite', groupId: group.id, email: 'bob@example.com', participantId: bobPerson.id })
    await access(bob, { action: 'join', shareUrl: again.invitation!.url! })
    expect(await tx((db) => requireMember(db, { principal: bob, group: group.id }))).toMatchObject({ participantId: bobPerson.id, role: 'member' })
  })

  it('binds a legacy member without a participant, once (P-ACCESS-60..64)', async () => {
    const g = await create(alice, { participants: ['Kim', 'Lee'] })
    await tx((db) => db.insert(memberships).values({ userId: cara.userId, groupId: g.id, role: 'member' }))
    let d = await details(alice, g.id)
    expect(d.unboundMembers).toEqual([{ userId: 'cara', name: 'Cara', email: 'cara@example.com', role: 'member' }])
    const kim = d.people.find((p) => p.name === 'Kim')!
    const lee = d.people.find((p) => p.name === 'Lee')!
    await expect(access(cara, { action: 'bind_member', groupId: g.id, userId: cara.userId, email: cara.email, participantId: kim.id })).rejects.toMatchObject({
      _tag: 'Forbidden',
    })
    await expect(access(alice, { action: 'bind_member', groupId: g.id, userId: cara.userId, email: 'x@example.com', participantId: kim.id })).rejects.toMatchObject({
      message: 'The verified email must match the existing member account.',
    })
    await access(alice, { action: 'bind_member', groupId: g.id, userId: cara.userId, email: cara.email, participantId: kim.id })
    d = await details(alice, g.id)
    expect(d.unboundMembers).toEqual([])
    expect(d.people.find((p) => p.id === kim.id)).toMatchObject({ name: 'Cara', status: 'joined' })
    await expect(access(alice, { action: 'bind_member', groupId: g.id, userId: cara.userId, email: cara.email, participantId: lee.id })).rejects.toMatchObject({
      message: 'That account is already tied to a different participant.',
    })
  })
})
