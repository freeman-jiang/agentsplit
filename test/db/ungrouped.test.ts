// The current app's scripts/test-ungrouped-expenses.ts scenarios, ported to v2:
// feed privacy, private contexts, invitations, ordering and settlement.
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expenses, groups, invitations, memberships, participants } from '../../db/schema/app'
import { user } from '../../db/schema/auth'
import { accountBalances, listBalances } from '~/server/balances'
import type { Db } from '~/server/core/db'
import { expenseContext, feedOptions, listFeed } from '~/server/feed'
import { createExpense, deleteExpense, getExpense, listExpenses, listGroups, updateExpense } from '~/server/ledger'
import { type Principal } from '~/server/core/access'
import { createUngroupedExpense, renewPrivateInvitation, type PrivatePerson } from '~/server/ungrouped'
import type { ExpenseDraft } from '~/shared/expense-rules'
import { randomId } from '~/server/core/ids'
import { testDatabase, type TestDatabase } from '../kit/database'

let database: TestDatabase
const BASE_URL = 'http://localhost:5183'

const tx = <A>(work: (db: Db) => Promise<A>) => database.tx(work)

const principal = (name: string): Principal => ({ userId: `u-${name.toLowerCase()}`, name, email: `${name.toLowerCase()}@example.com`, source: 'web', agentKeyId: null })
const alice = principal('Alice')
const bob = principal('Bob')
const carol = principal('Carol')
const outsider = principal('Outsider')
const guest = principal('Guest')
let keys = 0
const key = () => `test-key-${String(++keys).padStart(4, '0')}`

const draft = (over: Partial<ExpenseDraft> & Pick<ExpenseDraft, 'payers' | 'shares'>): ExpenseDraft => ({
  kind: 'expense',
  title: 'Shared meal',
  vendor: null,
  notes: '',
  categoryId: 0,
  expenseDate: '2026-10-09',
  currency: 'USD',
  amount: '60',
  splitMode: 'evenly',
  recurrence: 'none',
  ...over,
})
const even = (ids: string[]) => ids.map((participantId) => ({ participantId, weight: '1' }))
const paid = (participantId: string, amount = '60') => [{ participantId, amount }]

const people: PrivatePerson[] = [
  { kind: 'account', id: 'me', userId: alice.userId },
  { kind: 'account', id: 'friend', userId: bob.userId },
]
const privateId = randomId()
const [pAlice, pBob] = [`${privateId}_me`, `${privateId}_friend`]
const feedIds = async (p: Principal, filter: Parameters<typeof listFeed>[1]['filter'] = {}, limit = 100) =>
  (await tx((db) => listFeed(db, { principal: p, filter, cursor: null, limit }))).expenses.map((e) => e.id)

beforeAll(async () => {
  database = await testDatabase()
  await tx(async (db) => {
    const now = new Date()
    await db.insert(user).values(
      [alice, bob, carol, outsider, guest].map((p) => ({ id: p.userId, name: p.name, email: p.email, emailVerified: true, createdAt: now, updatedAt: now })),
    )
    await db.insert(user).values({ id: 'u-unverified', name: 'Unverified', email: 'unverified@example.com', emailVerified: false, createdAt: now, updatedAt: now })
    await db.insert(groups).values({ id: 'house', kind: 'named', slug: 'household', name: 'Household', defaultCurrency: 'USD' })
    await db.insert(participants).values([
      { id: 'h-alice', groupId: 'house', name: 'Alice' },
      { id: 'h-bob', groupId: 'house', name: 'Bob' },
      { id: 'h-carol', groupId: 'house', name: 'Carol' },
      { id: 'h-unverified', groupId: 'house', name: 'Unverified' },
    ])
    await db.insert(memberships).values([
      { userId: alice.userId, groupId: 'house', role: 'admin', participantId: 'h-alice' },
      { userId: bob.userId, groupId: 'house', participantId: 'h-bob' },
      { userId: carol.userId, groupId: 'house', participantId: 'h-carol' },
      { userId: 'u-unverified', groupId: 'house', participantId: 'h-unverified' },
    ])
  })
  await tx((db) => createExpense(db, { principal: bob, groupId: 'house', expenseId: 'only-bob', idempotencyKey: key(), expense: draft({ title: 'Only Bob', payers: paid('h-bob'), shares: even(['h-bob']) }) }))
  await tx((db) =>
    createExpense(db, {
      principal: alice,
      groupId: 'house',
      expenseId: 'supplies',
      idempotencyKey: key(),
      expense: draft({ title: 'Household supplies', payers: paid('h-alice'), shares: even(['h-alice', 'h-bob', 'h-carol']) }),
    }),
  )
  await tx((db) =>
    createUngroupedExpense(db, {
      principal: alice,
      baseUrl: BASE_URL,
      expenseId: privateId,
      idempotencyKey: key(),
      people,
      expense: draft({ title: 'Private dinner', payers: paid('me'), shares: even(['me', 'friend']) }),
    }),
  )
})
afterAll(async () => {
  await database.close()
})

describe('ungrouped expenses', () => {
  it('involving-me is based on participation, with all-accessible opt-in', async () => {
    const mine = await tx((db) => listFeed(db, { principal: alice, filter: { involvingMe: true }, cursor: null, limit: 100 }))
    expect(mine.expenses.map((e) => e.id)).toContain('supplies')
    expect(mine.expenses.find((e) => e.id === privateId)?.group).toBeNull()
    expect(mine.expenses.map((e) => e.id)).not.toContain('only-bob')
    // The default is "involving me", in the UI and for agents (DECISIONS.md, P-FEED-19).
    expect(await feedIds(alice)).toEqual(mine.expenses.map((e) => e.id))
    expect(await feedIds(alice, { involvingMe: false })).toContain('only-bob')
  })

  it('private expense is visible to participants and absent from named groups', async () => {
    expect(await feedIds(bob)).toContain(privateId)
    expect(await feedIds(carol, { involvingMe: false })).not.toContain(privateId)
    expect((await tx((db) => listGroups(db, alice))).map((g) => g.id)).toEqual(['house'])
  })

  it('non-participants cannot bypass privacy using IDs, filters or history', async () => {
    for (const peer of [carol, outsider]) {
      expect(await feedIds(peer, { groupId: privateId, involvingMe: false })).toEqual([])
      await expect(tx((db) => expenseContext(db, { principal: peer, expenseId: privateId }))).rejects.toMatchObject({ _tag: 'NotFound' })
      await expect(tx((db) => getExpense(db, { principal: peer, groupId: privateId, expenseId: privateId }))).rejects.toMatchObject({
        _tag: 'Forbidden',
        message: 'Group not found, or you are not a member',
      })
      await expect(tx((db) => listExpenses(db, { principal: peer, groupId: privateId, filter: {}, cursor: null, limit: 10 }))).rejects.toMatchObject({ _tag: 'Forbidden' })
    }
    // Its own people can filter by the private context's ID (DECISIONS.md, P-FEED-18).
    expect(await feedIds(bob, { groupId: privateId })).toEqual([privateId])
  })

  it('named group and no-group filters run before pagination', async () => {
    const ungrouped = await tx((db) => listFeed(db, { principal: alice, filter: { scope: 'ungrouped' }, cursor: null, limit: 100 }))
    expect(ungrouped.expenses.length).toBeGreaterThan(0)
    expect(ungrouped.expenses.every((e) => e.group === null)).toBe(true)
    const grouped = await tx((db) => listFeed(db, { principal: alice, filter: { scope: 'grouped' }, cursor: null, limit: 100 }))
    expect(grouped.expenses.every((e) => e.group !== null)).toBe(true)
    const house = await tx((db) => listFeed(db, { principal: alice, filter: { groupId: 'house' }, cursor: null, limit: 100 }))
    expect(house.expenses.every((e) => e.group?.id === 'house')).toBe(true)
    expect(
      await feedIds(alice, { search: 'private DINNER', payerUserId: alice.userId, personUserId: bob.userId, from: '2026-10-09', to: '2026-10-09', currency: 'USD' }, 1),
    ).toEqual([privateId])
    await expect(tx((db) => listFeed(db, { principal: alice, filter: { from: '2026-10-10', to: '2026-10-09' }, cursor: null, limit: 30 }))).rejects.toMatchObject({
      _tag: 'Invalid',
      message: 'The start date must be on or before the end date.',
    })
  })

  it('stable newest-first pagination survives a new expense at the head', async () => {
    const all = await feedIds(alice, { involvingMe: false })
    const first = await tx((db) => listFeed(db, { principal: alice, filter: { involvingMe: false }, cursor: null, limit: 1 }))
    expect(first.nextCursor).not.toBeNull()
    await tx((db) =>
      createExpense(db, {
        principal: alice,
        groupId: 'house',
        expenseId: 'new-head',
        idempotencyKey: key(),
        expense: draft({ title: 'New head', expenseDate: '2026-10-10', payers: paid('h-alice'), shares: even(['h-alice']) }),
      }),
    )
    const next = await tx((db) => listFeed(db, { principal: alice, filter: { involvingMe: false }, cursor: first.nextCursor, limit: 100 }))
    expect([...first.expenses.map((e) => e.id), ...next.expenses.map((e) => e.id)]).toEqual(all)
    expect((await tx((db) => listFeed(db, { principal: alice, filter: {}, cursor: null, limit: 1 }))).expenses[0]?.title).toBe('New head')
  })

  it('private access cannot be expanded or reclassified', async () => {
    await expect(
      tx((db) => createExpense(db, { principal: alice, groupId: privateId, expenseId: randomId(), idempotencyKey: key(), expense: draft({ payers: paid(pAlice), shares: even([pAlice, pBob]) }) })),
    ).rejects.toMatchObject({ _tag: 'Invalid', message: 'Create a separate ungrouped expense for a new purchase.' })
    await expect(
      tx((db) =>
        createExpense(db, {
          principal: alice,
          groupId: privateId,
          expenseId: randomId(),
          idempotencyKey: key(),
          expense: draft({ kind: 'payment', recurrence: 'monthly', payers: paid(pBob, '1'), shares: even([pAlice]), amount: '1' }),
        }),
      ),
    ).rejects.toMatchObject({ message: 'Ungrouped expenses do not recur.' })
    // The database refuses the same changes when the app checks are skipped.
    const refused = { cause: { code: '23514' } }
    await expect(tx((db) => db.insert(participants).values({ id: `${privateId}_extra`, groupId: privateId, name: 'Extra' }))).rejects.toMatchObject(refused)
    await expect(tx((db) => db.insert(memberships).values({ userId: outsider.userId, groupId: privateId, participantId: null }))).rejects.toMatchObject(refused)
    await expect(
      tx((db) => db.insert(invitations).values({ id: randomId(), groupId: privateId, email: outsider.email, participantId: pBob, tokenHash: randomId(), createdBy: alice.userId, expiresAt: new Date() })),
    ).rejects.toMatchObject(refused)
    await expect(tx((db) => db.update(groups).set({ kind: 'named' }).where(eq(groups.id, privateId)))).rejects.toMatchObject(refused)
    await expect(tx((db) => db.execute(sql`DELETE FROM private_people WHERE group_id = ${privateId}`))).rejects.toMatchObject(refused)
  })

  it('private editing preserves roster, exact money and revisions', async () => {
    await expect(
      tx((db) => updateExpense(db, { principal: alice, groupId: privateId, expenseId: privateId, expectedRevision: 1, idempotencyKey: key(), expense: draft({ payers: paid(pAlice), shares: even([pAlice]) }) })),
    ).rejects.toMatchObject({ message: 'The people with access to this private expense cannot be changed. Create a new expense for a different set of people.' })
    await expect(
      tx((db) =>
        updateExpense(db, { principal: alice, groupId: privateId, expenseId: privateId, expectedRevision: 1, idempotencyKey: key(), expense: draft({ kind: 'payment', payers: paid(pAlice), shares: even([pBob]) }) }),
      ),
    ).rejects.toMatchObject({ message: 'Record repayments separately from the original expense.' })
    // Any of its people may edit it, not only its creator.
    const edited = await tx((db) =>
      updateExpense(db, {
        principal: bob,
        groupId: privateId,
        expenseId: privateId,
        expectedRevision: 1,
        idempotencyKey: key(),
        expense: draft({ title: 'Private dinner corrected', payers: paid(pAlice), shares: even([pAlice, pBob]) }),
      }),
    )
    expect(edited.revision).toBe(2)
    expect(edited.shares.map((s) => s.amount)).toEqual(['30.00', '30.00'])
    await expect(
      tx((db) => updateExpense(db, { principal: alice, groupId: privateId, expenseId: privateId, expectedRevision: 1, idempotencyKey: key(), expense: draft({ title: 'Stale edit', payers: paid(pAlice), shares: even([pAlice, pBob]) }) })),
    ).rejects.toMatchObject({ _tag: 'Conflict', currentRevision: 2 })
  })

  it('repayment settles only the selected expense, preserving household balances', async () => {
    const before = await tx((db) => listBalances(db, { principal: alice, groupId: 'house' }))
    const owed = await tx((db) => expenseContext(db, { principal: alice, expenseId: privateId }))
    expect(owed.context?.settlements).toEqual([{ currency: 'USD', transfers: [{ from: pBob, to: pAlice, amount: '30.00' }] }])
    await tx((db) =>
      createExpense(db, {
        principal: bob,
        groupId: privateId,
        expenseId: 'repayment',
        idempotencyKey: key(),
        expense: draft({ kind: 'payment', title: 'Payment', amount: '30', categoryId: 1, payers: paid(pBob, '30'), shares: even([pAlice]) }),
      }),
    )
    const settled = await tx((db) => expenseContext(db, { principal: alice, expenseId: privateId }))
    expect(settled.context?.settlements).toEqual([{ currency: 'USD', transfers: [] }])
    expect(await tx((db) => listBalances(db, { principal: alice, groupId: 'house' }))).toEqual(before)
    await expect(tx((db) => deleteExpense(db, { principal: alice, groupId: privateId, expenseId: privateId, expectedRevision: 2, idempotencyKey: key() }))).rejects.toMatchObject({
      message: 'Remove this expense’s recorded repayments before deleting the expense.',
    })
    // A repayment's page names the original expense it settles.
    const payment = await tx((db) => expenseContext(db, { principal: bob, expenseId: 'repayment' }))
    expect(payment.context).toMatchObject({ expenseId: privateId, title: 'Private dinner corrected' })
  })

  it('three-person ad hoc expense and email invitation are private and atomic', async () => {
    const id = randomId()
    const roster: PrivatePerson[] = [...people, { kind: 'email', id: 'guest', email: ' NEW.Person@Example.com ', name: ' New person ' }]
    const result = await tx((db) =>
      createUngroupedExpense(db, {
        principal: alice,
        baseUrl: BASE_URL,
        expenseId: id,
        idempotencyKey: key(),
        people: roster,
        expense: draft({ title: 'Ad hoc three-person dinner', payers: paid('me'), shares: even(['me', 'friend', 'guest']) }),
      }),
    )
    expect(result).toMatchObject({ expenseId: id, groupId: id, revision: 1 })
    expect(result.participants).toEqual([
      { localId: 'me', participantId: `${id}_me`, name: 'Alice' },
      { localId: 'friend', participantId: `${id}_friend`, name: 'Bob' },
      { localId: 'guest', participantId: `${id}_guest`, name: 'New person' },
    ])
    expect(result.invitations).toHaveLength(1)
    const [link] = result.invitations
    expect(link?.email).toBe('new.person@example.com')
    expect(link?.url).toMatch(new RegExp(`^${BASE_URL}/invite/[A-Za-z0-9_-]{43}$`))
    // Only the SHA-256 hash of the secret is stored.
    const secret = link?.url.split('/').at(-1) ?? ''
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))).toString('hex')
    const [stored] = await tx((db) => db.select().from(invitations).where(eq(invitations.groupId, id)))
    expect(stored?.tokenHash).toBe(hash)
    expect(stored && stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000)
    // Expired invitations stay listed for the creator, so they can be renewed.
    await tx((db) => db.update(invitations).set({ expiresAt: new Date(0) }).where(eq(invitations.groupId, id)))
    expect((await tx((db) => expenseContext(db, { principal: alice, expenseId: id }))).context?.invitations).toHaveLength(1)
    expect((await tx((db) => expenseContext(db, { principal: bob, expenseId: id }))).context?.invitations).toEqual([])
    await expect(tx((db) => renewPrivateInvitation(db, { principal: outsider, baseUrl: BASE_URL, groupId: id, participantId: `${id}_guest` }))).rejects.toMatchObject({
      _tag: 'Forbidden',
      message: 'Group not found, or you are not a member',
    })
    await expect(tx((db) => renewPrivateInvitation(db, { principal: bob, baseUrl: BASE_URL, groupId: id, participantId: `${id}_guest` }))).rejects.toMatchObject({
      message: 'Only the expense creator can reissue its original invitations.',
    })
    await expect(tx((db) => renewPrivateInvitation(db, { principal: alice, baseUrl: BASE_URL, groupId: id, participantId: `${id}_friend` }))).rejects.toMatchObject({
      message: 'This person has already joined.',
    })
    const renewed = await tx((db) => renewPrivateInvitation(db, { principal: alice, baseUrl: BASE_URL, groupId: id, participantId: `${id}_guest` }))
    expect(renewed).toMatchObject({ email: 'new.person@example.com', participantId: `${id}_guest`, participantName: 'New person' })
    const rows = await tx((db) => db.select().from(invitations).where(eq(invitations.groupId, id)))
    expect(rows.filter((r) => r.revokedAt === null).map((r) => r.id)).toEqual([renewed.id])
    const log = await tx((db) => db.execute<{ data: string }>(sql`SELECT data FROM activities WHERE group_id = ${id} AND type = 'update_group'`))
    expect(log.rows.map((r) => r.data)).toEqual(['Private expense invitation renewed'])
    // The guest has no access until they join with a valid link (the invitations area).
    await expect(tx((db) => expenseContext(db, { principal: guest, expenseId: id }))).rejects.toMatchObject({ _tag: 'NotFound' })
    const count = (await tx((db) => db.select({ id: expenses.id }).from(expenses))).length
    await expect(
      tx((db) =>
        createUngroupedExpense(db, {
          principal: alice,
          baseUrl: BASE_URL,
          expenseId: id,
          idempotencyKey: key(),
          people: roster,
          expense: draft({ payers: paid('me'), shares: even(['me', 'friend', 'guest']) }),
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'Conflict', id })
    expect((await tx((db) => db.select({ id: expenses.id }).from(expenses))).length).toBe(count)
  })

  it('forged account IDs and uninvolved extra viewers are rejected', async () => {
    const forged: PrivatePerson[] = [...people, { kind: 'account', id: 'stranger', userId: outsider.userId }]
    const create = (data: { people: PrivatePerson[]; expense: ExpenseDraft }) =>
      tx((db) => createUngroupedExpense(db, { principal: alice, baseUrl: BASE_URL, expenseId: randomId(), idempotencyKey: key(), ...data }))
    await expect(create({ people: forged, expense: draft({ payers: paid('me'), shares: even(['me', 'friend', 'stranger']) }) })).rejects.toMatchObject({
      message: 'Choose an existing contact or invite someone by email.',
    })
    const exact = 'Include yourself and exactly the people paying for or sharing this expense. Each person must be unique.'
    await expect(create({ people, expense: draft({ payers: paid('me'), shares: even(['me']) }) })).rejects.toMatchObject({ message: exact })
    await expect(
      create({ people: [people[1]!, { kind: 'email', id: 'x', name: 'X', email: 'x@example.com' }], expense: draft({ payers: paid('friend'), shares: even(['friend', 'x']) }) }),
    ).rejects.toMatchObject({ message: exact })
    await expect(
      create({ people: [...people, { kind: 'email', id: 'twin', name: 'Twin', email: bob.email }], expense: draft({ payers: paid('me'), shares: even(['me', 'friend', 'twin']) }) }),
    ).rejects.toMatchObject({ message: exact })
    // The private write rules check the new expense, as they check every later write.
    await expect(create({ people, expense: draft({ kind: 'payment', payers: paid('me'), shares: even(['me', 'friend']) }) })).rejects.toMatchObject({
      message: 'Record repayments separately from the original expense.',
    })
    await expect(create({ people, expense: draft({ recurrence: 'weekly', payers: paid('me'), shares: even(['me', 'friend']) }) })).rejects.toMatchObject({
      message: 'Ungrouped expenses do not recur.',
    })
    await expect(
      create({ people: [people[0]!, { kind: 'email', id: 'x', name: ' ', email: 'x@example.com' }], expense: draft({ payers: paid('me'), shares: even(['me', 'x']) }) }),
    ).rejects.toMatchObject({ message: 'Enter a name and a valid email address.' })
    const unverified = { ...principal('Unverified'), userId: 'u-unverified' }
    await expect(
      tx((db) =>
        createUngroupedExpense(db, {
          principal: unverified,
          baseUrl: BASE_URL,
          expenseId: randomId(),
          idempotencyKey: key(),
          people: [{ kind: 'account', id: 'me', userId: 'u-unverified' }, { kind: 'account', id: 'a', userId: alice.userId }],
          expense: draft({ payers: paid('me'), shares: even(['me', 'a']) }),
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'Unauthorized' })
  })

  it('contact lookup exposes only shared verified members and self', async () => {
    expect((await tx((db) => feedOptions(db, { principal: outsider }))).people.map((p) => p.id)).toEqual([outsider.userId])
    const options = await tx((db) => feedOptions(db, { principal: alice }))
    expect(options.people).toEqual([
      { id: alice.userId, name: 'Alice', email: alice.email },
      { id: bob.userId, name: 'Bob', email: bob.email },
      { id: carol.userId, name: 'Carol', email: carol.email },
    ])
    expect(options.groups).toEqual([{ id: 'house', name: 'Household', slug: 'household' }])
    expect(options.userId).toBe(alice.userId)
  })

  it('dashboard totals include private contexts, separate currencies and preserve partial-state warnings', async () => {
    // Household +40, private dinner 0 after the repayment, three-person dinner +40.
    const summary = await tx((db) => accountBalances(db, { principal: alice }))
    expect(summary.totals).toEqual([{ currency: 'USD', amount: '80.00' }])
    expect(summary.balances.some((b) => b.groupId === privateId && b.kind === 'private')).toBe(true)
    expect(summary.unboundGroupIds).toEqual([])
    expect(await tx((db) => accountBalances(db, { principal: outsider }))).toEqual({ balances: [], totals: [], unboundGroupIds: [] })
    await tx((db) =>
      createExpense(db, {
        principal: alice,
        groupId: 'house',
        expenseId: 'euro',
        idempotencyKey: key(),
        expense: draft({ title: 'Euro expense', amount: '10', currency: 'EUR', payers: paid('h-alice', '10'), shares: even(['h-alice', 'h-bob']) }),
      }),
    )
    expect((await tx((db) => accountBalances(db, { principal: alice }))).totals).toEqual([
      { currency: 'EUR', amount: '5.00' },
      { currency: 'USD', amount: '80.00' },
    ])
    await tx(async (db) => {
      await db.insert(groups).values({ id: 'legacy', kind: 'named', name: 'Unbound legacy test', defaultCurrency: 'USD' })
      await db.insert(memberships).values({ userId: alice.userId, groupId: 'legacy', participantId: null })
    })
    const partial = await tx((db) => accountBalances(db, { principal: alice }))
    expect(partial.unboundGroupIds).toEqual(['legacy'])
    expect(partial.totals).toEqual([
      { currency: 'EUR', amount: '5.00' },
      { currency: 'USD', amount: '80.00' },
    ])
    // Reading balances never creates expenses (no recurring side effect).
    const before = (await tx((db) => db.select({ id: expenses.id }).from(expenses))).length
    await tx((db) => accountBalances(db, { principal: alice }))
    expect((await tx((db) => db.select({ id: expenses.id }).from(expenses))).length).toBe(before)
  })

  it('deletes the original after its repayments, and then refuses new repayments', async () => {
    await tx((db) => deleteExpense(db, { principal: bob, groupId: privateId, expenseId: 'repayment', expectedRevision: 1, idempotencyKey: key() }))
    await tx((db) => deleteExpense(db, { principal: alice, groupId: privateId, expenseId: privateId, expectedRevision: 2, idempotencyKey: key() }))
    const log = await tx((db) => db.execute<{ type: string }>(sql`SELECT type FROM activities WHERE group_id = ${privateId} ORDER BY sequence`))
    expect(log.rows.map((r) => r.type)).toEqual(['create_group', 'create_expense', 'update_expense', 'create_expense', 'delete_expense', 'delete_expense'])
    await expect(
      tx((db) =>
        createExpense(db, {
          principal: bob,
          groupId: privateId,
          expenseId: randomId(),
          idempotencyKey: key(),
          expense: draft({ kind: 'payment', amount: '1', payers: paid(pBob, '1'), shares: even([pAlice]) }),
        }),
      ),
    ).rejects.toMatchObject({ message: 'Cannot record a repayment for a deleted expense.' })
    expect(await feedIds(alice, { groupId: privateId })).toEqual([])
  })
  it('links an invited email that belongs to a contact, without an invitation', async () => {
    const id = randomId()
    const result = await tx((db) =>
      createUngroupedExpense(db, {
        principal: alice,
        baseUrl: BASE_URL,
        expenseId: id,
        idempotencyKey: key(),
        people: [people[0]!, { kind: 'email', id: 'c', name: 'Typed name', email: 'CAROL@example.com' }],
        expense: draft({ payers: paid('me'), shares: even(['me', 'c']) }),
      }),
    )
    expect(result.invitations).toEqual([])
    expect(result.participants.find((p) => p.localId === 'c')?.name).toBe('Carol')
    expect(await feedIds(carol, { groupId: id })).toEqual([id])
  })
})
