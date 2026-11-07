// The current app's scripts/test-ungrouped-expenses.ts scenarios, ported to v2:
// feed privacy, private contexts, invitations, ordering and settlement.
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GROUP_DENIED } from '~/shared/errors'
import { expenses, groups, invitations, memberships, participants } from '../../db/schema/app'
import { user } from '../../db/schema/auth'
import { accountBalances, listBalances } from '~/server/balances'
import { sqlState } from '~/server/core/db'
import { expenseContext, feedOptions, listFeed } from '~/server/feed'
import { createExpense, deleteExpense, getExpense, listExpenses, listGroups, updateExpense } from '~/server/ledger'
import { type Principal } from '~/server/core/access'
import { createUngroupedExpense, renewPrivateInvitation, type PrivatePerson } from '~/server/ungrouped'
import type { ExpenseDraft } from '~/shared/expense-rules'
import { randomId } from '~/shared/ids'
import { BASE } from '../kit/config'
import { testDatabase, type TestDatabase } from '../kit/database'
import { draft } from '../kit/drafts'
import { counter } from '../kit/ids'
import { principal, userRows } from '../kit/people'

let database: TestDatabase

const tx: TestDatabase['tx'] = (work) => database.tx(work)

const alice = principal('u-alice', { name: 'Alice' })
const bob = principal('u-bob', { name: 'Bob' })
const carol = principal('u-carol', { name: 'Carol' })
const outsider = principal('u-outsider', { name: 'Outsider' })
const guest = principal('u-guest', { name: 'Guest' })
const unverified = principal('u-unverified', { name: 'Unverified' })
const key = counter('key-ungrouped')

/** A meal of 60 on 2026-10-09, paid by `payer` and shared evenly by `people`. */
const meal = (data: { payer: string; people: readonly string[] } & Partial<ExpenseDraft>) => draft({ title: 'Shared meal', expenseDate: '2026-10-09', amount: '60', ...data })

/** Alice and Bob, the people of the private dinners. */
const people: PrivatePerson[] = [
  { kind: 'account', id: 'me', userId: alice.userId },
  { kind: 'account', id: 'friend', userId: bob.userId },
]

type Dinner = { id: string; me: string; friend: string }
/**
 * A new private expense of 60 that `owner` pays and shares evenly with
 * `friend`, both accounts. Its ID is also its group's. The default title does
 * not match the filters that find the shared fixture.
 */
async function privateDinner(data: { owner?: Principal; friend?: Principal; title?: string } = {}): Promise<Dinner> {
  const owner = data.owner ?? alice
  const id = randomId()
  await tx((db) =>
    createUngroupedExpense(db, {
      principal: owner,
      baseUrl: BASE,
      expenseId: id,
      idempotencyKey: key(),
      people: [
        { kind: 'account', id: 'me', userId: owner.userId },
        { kind: 'account', id: 'friend', userId: (data.friend ?? bob).userId },
      ],
      expense: meal({ title: data.title ?? 'Dinner for two', payer: 'me', people: ['me', 'friend'] }),
    }),
  )
  return { id, me: `${id}_me`, friend: `${id}_friend` }
}
/** A repayment from the friend to the owner of `dinner`, recorded by `by`. */
const repay = (data: { dinner: Dinner; by: Principal; expenseId?: string; amount?: string }) =>
  tx((db) =>
    createExpense(db, {
      principal: data.by,
      groupId: data.dinner.id,
      expenseId: data.expenseId ?? randomId(),
      idempotencyKey: key(),
      expense: meal({ kind: 'payment', title: 'Payment', amount: data.amount ?? '30', categoryId: 1, payer: data.dinner.friend, people: [data.dinner.me] }),
    }),
  )

const feedIds = async (data: { principal: Principal; filter?: Parameters<typeof listFeed>[1]['filter']; limit?: number }) =>
  (await tx((db) => listFeed(db, { principal: data.principal, filter: data.filter ?? {}, cursor: null, limit: data.limit ?? 100 }))).expenses.map((e) => e.id)

// The read-only fixture: the household and the private dinner of Alice and Bob.
let privateId: string

beforeAll(async () => {
  database = await testDatabase()
  await tx(async (db) => {
    await db.insert(user).values(userRows([alice, bob, carol, outsider, guest], { verified: true }))
    await db.insert(user).values(userRows([unverified]))
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
      { userId: unverified.userId, groupId: 'house', participantId: 'h-unverified' },
    ])
  })
  await tx((db) => createExpense(db, { principal: bob, groupId: 'house', expenseId: 'only-bob', idempotencyKey: key(), expense: meal({ title: 'Only Bob', payer: 'h-bob', people: ['h-bob'] }) }))
  await tx((db) =>
    createExpense(db, {
      principal: alice,
      groupId: 'house',
      expenseId: 'supplies',
      idempotencyKey: key(),
      expense: meal({ title: 'Household supplies', payer: 'h-alice', people: ['h-alice', 'h-bob', 'h-carol'] }),
    }),
  )
  privateId = (await privateDinner({ title: 'Private dinner' })).id
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
    expect(await feedIds({ principal: alice })).toEqual(mine.expenses.map((e) => e.id))
    expect(await feedIds({ principal: alice, filter: { involvingMe: false } })).toContain('only-bob')
  })

  it('private expense is visible to participants and absent from named groups', async () => {
    expect(await feedIds({ principal: bob })).toContain(privateId)
    expect(await feedIds({ principal: carol, filter: { involvingMe: false } })).not.toContain(privateId)
    expect((await tx((db) => listGroups(db, alice))).map((g) => g.id)).toEqual(['house'])
  })

  it('non-participants cannot bypass privacy using IDs, filters or history', async () => {
    for (const peer of [carol, outsider]) {
      expect(await feedIds({ principal: peer, filter: { groupId: privateId, involvingMe: false } })).toEqual([])
      await expect(tx((db) => expenseContext(db, { principal: peer, expenseId: privateId }))).rejects.toMatchObject({ _tag: 'NotFound' })
      await expect(tx((db) => getExpense(db, { principal: peer, groupId: privateId, expenseId: privateId }))).rejects.toMatchObject({
        _tag: 'Forbidden',
        message: GROUP_DENIED,
      })
      await expect(tx((db) => listExpenses(db, { principal: peer, groupId: privateId, filter: {}, cursor: null, limit: 10 }))).rejects.toMatchObject({ _tag: 'Forbidden' })
    }
    // Its own people can filter by the private context's ID (DECISIONS.md, P-FEED-18).
    expect(await feedIds({ principal: bob, filter: { groupId: privateId } })).toEqual([privateId])
  })

  it('named group and no-group filters run before pagination', async () => {
    const ids = (filter: Parameters<typeof listFeed>[1]['filter']) => tx((db) => listFeed(db, { principal: alice, filter, cursor: null, limit: 100 })).then((r) => r.expenses)
    const ungrouped = await ids({ scope: 'ungrouped' })
    expect(ungrouped.map((e) => e.id)).toContain(privateId)
    expect(ungrouped.every((e) => e.group === null)).toBe(true)
    const grouped = await ids({ scope: 'grouped' })
    expect(grouped.map((e) => e.id)).toContain('supplies')
    expect(grouped.every((e) => e.group !== null)).toBe(true)
    const house = await ids({ groupId: 'house' })
    expect(house.map((e) => e.id)).toContain('supplies')
    expect(house.every((e) => e.group?.id === 'house')).toBe(true)
    expect(
      await feedIds({ principal: alice, filter: { search: 'private DINNER', payerUserId: alice.userId, personUserId: bob.userId, from: '2026-10-09', to: '2026-10-09', currency: 'USD' }, limit: 1 }),
    ).toEqual([privateId])
    await expect(tx((db) => listFeed(db, { principal: alice, filter: { from: '2026-10-10', to: '2026-10-09' }, cursor: null, limit: 30 }))).rejects.toMatchObject({
      _tag: 'Invalid',
      message: 'The start date must be on or before the end date.',
    })
  })

  it('stable newest-first pagination survives a new expense at the head', async () => {
    const all = await feedIds({ principal: alice, filter: { involvingMe: false } })
    const first = await tx((db) => listFeed(db, { principal: alice, filter: { involvingMe: false }, cursor: null, limit: 1 }))
    expect(first.nextCursor).not.toBeNull()
    // Alice alone shares it, so no balance changes.
    await tx((db) =>
      createExpense(db, {
        principal: alice,
        groupId: 'house',
        expenseId: 'new-head',
        idempotencyKey: key(),
        expense: meal({ title: 'New head', expenseDate: '2026-10-10', payer: 'h-alice', people: ['h-alice'] }),
      }),
    )
    const next = await tx((db) => listFeed(db, { principal: alice, filter: { involvingMe: false }, cursor: first.nextCursor, limit: 100 }))
    expect([...first.expenses.map((e) => e.id), ...next.expenses.map((e) => e.id)]).toEqual(all)
    expect((await tx((db) => listFeed(db, { principal: alice, filter: {}, cursor: null, limit: 1 }))).expenses[0]?.title).toBe('New head')
  })

  it('private access cannot be expanded or reclassified', async () => {
    const d = await privateDinner()
    await expect(
      tx((db) => createExpense(db, { principal: alice, groupId: d.id, expenseId: randomId(), idempotencyKey: key(), expense: meal({ payer: d.me, people: [d.me, d.friend] }) })),
    ).rejects.toMatchObject({ _tag: 'Invalid', message: 'Create a separate ungrouped expense for a new purchase.' })
    await expect(
      tx((db) =>
        createExpense(db, {
          principal: alice,
          groupId: d.id,
          expenseId: randomId(),
          idempotencyKey: key(),
          expense: meal({ kind: 'payment', recurrence: 'monthly', amount: '1', payer: d.friend, people: [d.me] }),
        }),
      ),
    ).rejects.toMatchObject({ message: 'Ungrouped expenses do not recur.' })
    // The database refuses the same changes when the app checks are skipped: 23514 is a failed check or trigger.
    const refused = (write: Promise<unknown>) => expect(write.catch(sqlState)).resolves.toBe('23514')
    await refused(tx((db) => db.insert(participants).values({ id: `${d.id}_extra`, groupId: d.id, name: 'Extra' })))
    await refused(tx((db) => db.insert(memberships).values({ userId: outsider.userId, groupId: d.id, participantId: null })))
    await refused(tx((db) => db.insert(invitations).values({ id: randomId(), groupId: d.id, email: outsider.email, participantId: d.friend, tokenHash: randomId(), createdBy: alice.userId, expiresAt: new Date() })))
    await refused(tx((db) => db.update(groups).set({ kind: 'named' }).where(eq(groups.id, d.id))))
    await refused(tx((db) => db.execute(sql`DELETE FROM private_people WHERE group_id = ${d.id}`)))
  })

  it('private editing preserves roster, exact money and revisions', async () => {
    const d = await privateDinner()
    const edit = (data: { principal: Principal; expense: ExpenseDraft }) =>
      tx((db) => updateExpense(db, { principal: data.principal, groupId: d.id, expenseId: d.id, expectedRevision: 1, idempotencyKey: key(), expense: data.expense }))
    await expect(edit({ principal: alice, expense: meal({ payer: d.me, people: [d.me] }) })).rejects.toMatchObject({
      message: 'The people with access to this private expense cannot be changed. Create a new expense for a different set of people.',
    })
    await expect(edit({ principal: alice, expense: meal({ kind: 'payment', payer: d.me, people: [d.friend] }) })).rejects.toMatchObject({
      message: 'Record repayments separately from the original expense.',
    })
    // Any of its people may edit it, not only its creator.
    const edited = await edit({ principal: bob, expense: meal({ title: 'Dinner for two, corrected', payer: d.me, people: [d.me, d.friend] }) })
    expect(edited.revision).toBe(2)
    expect(edited.shares.map((s) => s.amount)).toEqual(['30.00', '30.00'])
    await expect(edit({ principal: alice, expense: meal({ title: 'Stale edit', payer: d.me, people: [d.me, d.friend] }) })).rejects.toMatchObject({ _tag: 'Conflict', currentRevision: 2 })
  })

  it('repayment settles only the selected expense, preserving household balances', async () => {
    const d = await privateDinner()
    const before = await tx((db) => listBalances(db, { principal: alice, groupId: 'house' }))
    const owed = await tx((db) => expenseContext(db, { principal: alice, expenseId: d.id }))
    expect(owed.context?.settlements).toEqual([{ currency: 'USD', transfers: [{ from: d.friend, to: d.me, amount: '30.00' }] }])
    const repayment = randomId()
    await repay({ dinner: d, by: bob, expenseId: repayment })
    const settled = await tx((db) => expenseContext(db, { principal: alice, expenseId: d.id }))
    expect(settled.context?.settlements).toEqual([{ currency: 'USD', transfers: [] }])
    expect(await tx((db) => listBalances(db, { principal: alice, groupId: 'house' }))).toEqual(before)
    await expect(tx((db) => deleteExpense(db, { principal: alice, groupId: d.id, expenseId: d.id, expectedRevision: 1, idempotencyKey: key() }))).rejects.toMatchObject({
      message: 'Remove this expense’s recorded repayments before deleting the expense.',
    })
    // A repayment's page names the original expense it settles.
    const payment = await tx((db) => expenseContext(db, { principal: bob, expenseId: repayment }))
    expect(payment.context).toMatchObject({ expenseId: d.id, title: 'Dinner for two' })
  })

  it('three-person ad hoc expense and email invitation are private and atomic', async () => {
    const id = randomId()
    const roster: PrivatePerson[] = [...people, { kind: 'email', id: 'guest', email: ' NEW.Person@Example.com ', name: ' New person ' }]
    const result = await tx((db) =>
      createUngroupedExpense(db, {
        principal: alice,
        baseUrl: BASE,
        expenseId: id,
        idempotencyKey: key(),
        people: roster,
        expense: meal({ title: 'Ad hoc three-person dinner', payer: 'me', people: ['me', 'friend', 'guest'] }),
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
    expect(link?.url).toMatch(new RegExp(`^${BASE}/invite/[A-Za-z0-9_-]{43}$`))
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
    await expect(tx((db) => renewPrivateInvitation(db, { principal: outsider, baseUrl: BASE, groupId: id, participantId: `${id}_guest` }))).rejects.toMatchObject({
      _tag: 'Forbidden',
      message: GROUP_DENIED,
    })
    await expect(tx((db) => renewPrivateInvitation(db, { principal: bob, baseUrl: BASE, groupId: id, participantId: `${id}_guest` }))).rejects.toMatchObject({
      message: 'Only the expense creator can reissue its original invitations.',
    })
    await expect(tx((db) => renewPrivateInvitation(db, { principal: alice, baseUrl: BASE, groupId: id, participantId: `${id}_friend` }))).rejects.toMatchObject({
      message: 'This person has already joined.',
    })
    const renewed = await tx((db) => renewPrivateInvitation(db, { principal: alice, baseUrl: BASE, groupId: id, participantId: `${id}_guest` }))
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
          baseUrl: BASE,
          expenseId: id,
          idempotencyKey: key(),
          people: roster,
          expense: meal({ payer: 'me', people: ['me', 'friend', 'guest'] }),
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'Conflict', id })
    expect((await tx((db) => db.select({ id: expenses.id }).from(expenses))).length).toBe(count)
  })

  it('forged account IDs and uninvolved extra viewers are rejected', async () => {
    const forged: PrivatePerson[] = [...people, { kind: 'account', id: 'stranger', userId: outsider.userId }]
    const create = (data: { people: PrivatePerson[]; expense: ExpenseDraft }) =>
      tx((db) => createUngroupedExpense(db, { principal: alice, baseUrl: BASE, expenseId: randomId(), idempotencyKey: key(), ...data }))
    await expect(create({ people: forged, expense: meal({ payer: 'me', people: ['me', 'friend', 'stranger'] }) })).rejects.toMatchObject({
      message: 'Choose an existing contact or invite someone by email.',
    })
    const exact = 'Include yourself and exactly the people paying for or sharing this expense. Each person must be unique.'
    await expect(create({ people, expense: meal({ payer: 'me', people: ['me'] }) })).rejects.toMatchObject({ message: exact })
    await expect(create({ people: [people[1]!, { kind: 'email', id: 'x', name: 'X', email: 'x@example.com' }], expense: meal({ payer: 'friend', people: ['friend', 'x'] }) })).rejects.toMatchObject({
      message: exact,
    })
    await expect(
      create({ people: [...people, { kind: 'email', id: 'twin', name: 'Twin', email: bob.email }], expense: meal({ payer: 'me', people: ['me', 'friend', 'twin'] }) }),
    ).rejects.toMatchObject({ message: exact })
    // The private write rules check the new expense, as they check every later write.
    await expect(create({ people, expense: meal({ kind: 'payment', payer: 'me', people: ['me', 'friend'] }) })).rejects.toMatchObject({
      message: 'Record repayments separately from the original expense.',
    })
    await expect(create({ people, expense: meal({ recurrence: 'weekly', payer: 'me', people: ['me', 'friend'] }) })).rejects.toMatchObject({
      message: 'Ungrouped expenses do not recur.',
    })
    await expect(create({ people: [people[0]!, { kind: 'email', id: 'x', name: ' ', email: 'x@example.com' }], expense: meal({ payer: 'me', people: ['me', 'x'] }) })).rejects.toMatchObject({
      message: 'Enter a name and a valid email address.',
    })
    await expect(
      tx((db) =>
        createUngroupedExpense(db, {
          principal: unverified,
          baseUrl: BASE,
          expenseId: randomId(),
          idempotencyKey: key(),
          people: [
            { kind: 'account', id: 'me', userId: unverified.userId },
            { kind: 'account', id: 'a', userId: alice.userId },
          ],
          expense: meal({ payer: 'me', people: ['me', 'a'] }),
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
    // Dana's own accounts and groups, so no other test changes her totals.
    const dana = principal('u-dana', { name: 'Dana' })
    const erin = principal('u-erin', { name: 'Erin' })
    await tx(async (db) => {
      await db.insert(user).values(userRows([dana, erin], { verified: true }))
      await db.insert(groups).values({ id: 'dana-house', kind: 'named', name: 'Dana house', defaultCurrency: 'USD' })
      await db.insert(participants).values([
        { id: 'd-dana', groupId: 'dana-house', name: 'Dana' },
        { id: 'd-erin', groupId: 'dana-house', name: 'Erin' },
        { id: 'd-fay', groupId: 'dana-house', name: 'Fay' },
      ])
      await db.insert(memberships).values([
        { userId: dana.userId, groupId: 'dana-house', role: 'admin', participantId: 'd-dana' },
        { userId: erin.userId, groupId: 'dana-house', participantId: 'd-erin' },
      ])
    })
    await tx((db) => createExpense(db, { principal: dana, groupId: 'dana-house', expenseId: randomId(), idempotencyKey: key(), expense: meal({ payer: 'd-dana', people: ['d-dana', 'd-erin', 'd-fay'] }) }))
    const repaid = await privateDinner({ owner: dana, friend: erin })
    await repay({ dinner: repaid, by: erin })
    await tx((db) =>
      createUngroupedExpense(db, {
        principal: dana,
        baseUrl: BASE,
        expenseId: randomId(),
        idempotencyKey: key(),
        people: [
          { kind: 'account', id: 'me', userId: dana.userId },
          { kind: 'account', id: 'friend', userId: erin.userId },
          { kind: 'email', id: 'guest', name: 'Guest', email: 'dana-guest@example.com' },
        ],
        expense: meal({ payer: 'me', people: ['me', 'friend', 'guest'] }),
      }),
    )
    // Household +40, the repaid dinner 0, the three-person dinner +40.
    const summary = await tx((db) => accountBalances(db, { principal: dana }))
    expect(summary.totals).toEqual([{ currency: 'USD', amount: '80.00' }])
    expect(summary.balances.find((b) => b.groupId === repaid.id)).toMatchObject({ kind: 'private', currency: 'USD', amount: '0.00' })
    expect(summary.unboundGroupIds).toEqual([])
    expect(await tx((db) => accountBalances(db, { principal: outsider }))).toEqual({ balances: [], totals: [], unboundGroupIds: [] })
    await tx((db) =>
      createExpense(db, {
        principal: dana,
        groupId: 'dana-house',
        expenseId: randomId(),
        idempotencyKey: key(),
        expense: meal({ title: 'Euro expense', amount: '10', currency: 'EUR', payer: 'd-dana', people: ['d-dana', 'd-erin'] }),
      }),
    )
    expect((await tx((db) => accountBalances(db, { principal: dana }))).totals).toEqual([
      { currency: 'EUR', amount: '5.00' },
      { currency: 'USD', amount: '80.00' },
    ])
    await tx(async (db) => {
      await db.insert(groups).values({ id: 'dana-legacy', kind: 'named', name: 'Unbound legacy test', defaultCurrency: 'USD' })
      await db.insert(memberships).values({ userId: dana.userId, groupId: 'dana-legacy', participantId: null })
    })
    const partial = await tx((db) => accountBalances(db, { principal: dana }))
    expect(partial.unboundGroupIds).toEqual(['dana-legacy'])
    expect(partial.totals).toEqual([
      { currency: 'EUR', amount: '5.00' },
      { currency: 'USD', amount: '80.00' },
    ])
    // Reading balances never creates expenses (no recurring side effect).
    const before = (await tx((db) => db.select({ id: expenses.id }).from(expenses))).length
    await tx((db) => accountBalances(db, { principal: dana }))
    expect((await tx((db) => db.select({ id: expenses.id }).from(expenses))).length).toBe(before)
  })

  it('deletes the original after its repayments, and then refuses new repayments', async () => {
    const d = await privateDinner()
    const repayment = randomId()
    await repay({ dinner: d, by: bob, expenseId: repayment })
    await tx((db) => deleteExpense(db, { principal: bob, groupId: d.id, expenseId: repayment, expectedRevision: 1, idempotencyKey: key() }))
    await tx((db) => deleteExpense(db, { principal: alice, groupId: d.id, expenseId: d.id, expectedRevision: 1, idempotencyKey: key() }))
    const log = await tx((db) => db.execute<{ type: string }>(sql`SELECT type FROM activities WHERE group_id = ${d.id} ORDER BY sequence`))
    expect(log.rows.map((r) => r.type)).toEqual(['create_group', 'create_expense', 'create_expense', 'delete_expense', 'delete_expense'])
    await expect(repay({ dinner: d, by: bob, amount: '1' })).rejects.toMatchObject({ message: 'Cannot record a repayment for a deleted expense.' })
    expect(await feedIds({ principal: alice, filter: { groupId: d.id } })).toEqual([])
  })

  it('links an invited email that belongs to a contact, without an invitation', async () => {
    const id = randomId()
    const result = await tx((db) =>
      createUngroupedExpense(db, {
        principal: alice,
        baseUrl: BASE,
        expenseId: id,
        idempotencyKey: key(),
        people: [people[0]!, { kind: 'email', id: 'c', name: 'Typed name', email: carol.email.toUpperCase() }],
        expense: meal({ payer: 'me', people: ['me', 'c'] }),
      }),
    )
    expect(result.invitations).toEqual([])
    expect(result.participants.find((p) => p.localId === 'c')?.name).toBe('Carol')
    expect(await feedIds({ principal: carol, filter: { groupId: id } })).toEqual([id])
  })
})
