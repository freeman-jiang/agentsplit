// The synthetic people of the capacity benchmark: accounts in named groups of
// 2 to 6 people, a year of expense history written through the ledger, a
// signed web session and a Better Auth API key for each account.
import { user } from '../../db/schema/auth'
import { createAuth } from '../../src/server/auth/auth'
import type { AuthSettings } from '../../src/server/core/config'
import { serializable, type Db } from '../../src/server/core/db'
import { createExpense } from '../../src/server/ledger'
import { draft } from '../../test/kit/drafts'
import { principal, userRows } from '../../test/kit/people'
import { seedGroup } from '../../test/kit/seed'
import { signIn, type SessionCookie } from '../../test/kit/session'

/** A seeded generator in [0, 1), so a run with the same seed writes the same data. */
export function generator(seed: number) {
  let state = seed % 2 ** 31
  return () => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
}
export type Random = ReturnType<typeof generator>

const pick = <A>(random: Random, items: readonly [A, ...A[]]): A => items[Math.floor(random() * items.length)] ?? items[0]

export type SyntheticGroup = {
  readonly id: string
  readonly slug: string
  readonly name: string
  /** Participant IDs, in the order of `members`. */
  readonly participants: readonly string[]
  readonly members: readonly string[]
}

export type SyntheticUser = {
  readonly userId: string
  readonly name: string
  /** The client address that the edge forwards in X-Forwarded-For: one per person, as in production. */
  readonly ip: string
  /** The group that this person opens and adds expenses to: their first one. */
  readonly home: SyntheticGroup
  /** This person's participant in `home`. */
  readonly participantId: string
}

export type Credentials = { readonly cookie: SessionCookie; readonly apiKey: string }

export type Seeded = {
  readonly users: readonly SyntheticUser[]
  readonly groups: readonly SyntheticGroup[]
  /** Expenses written by the seed, per group. */
  readonly history: readonly number[]
}

/** The text-only notes that agents and people write instead of receipt images. */
export const noteText = (random: Random) =>
  pick(random, [
    'Paid at the counter; the receipt total includes tax and a 15% tip.',
    'Two bags of groceries for the week. Split evenly as usual.',
    'Monthly utilities, from the online statement of the 1st.',
    'Bought for the shared kitchen. Keep the box until the return window closes.',
  ])

const isoDay = (date: Date) => date.toISOString().slice(0, 10)

/**
 * Writes `count` accounts in groups of 2 to 6 people (most groups small),
 * where about a third of the groups after the first also hold someone from
 * an earlier group. Most groups get 10 to 60 expenses over the last year; one
 * group in ten (at least one) gets 300 to 500.
 */
export async function seedPeople(db: Db, data: { count: number; random: Random; today: Date }): Promise<Seeded> {
  const { count, random } = data
  const names = Array.from({ length: count }, (_, i) => ({ userId: `cap-u${i + 1}`, name: `Person ${i + 1}` }))
  await db.insert(user).values(userRows(names.map((n) => principal(n.userId, { name: n.name })), { verified: true }))

  const groupMembers: string[][] = []
  let next = 0
  while (next < count) {
    let size = Math.min(pick(random, [2, 2, 2, 3, 3, 4, 4, 5, 6]), count - next)
    // A single person must not be left over for a group of one.
    if (count - next - size === 1) size += size < 6 ? 1 : -1
    const members = names.slice(next, next + size).map((n) => n.userId)
    next += size
    const earlier = groupMembers.flat()
    const guest = earlier[Math.floor(random() * earlier.length)]
    if (groupMembers.length > 0 && guest && members.length < 6 && random() < 0.35) members.push(guest)
    groupMembers.push(members)
  }
  if (groupMembers.some((m) => m.length < 2)) throw new Error('Use at least 2 people')

  const nameOf = new Map(names.map((n) => [n.userId, n.name]))
  const bigEvery = 10
  const groups: SyntheticGroup[] = []
  const history: number[] = []
  for (const [index, members] of groupMembers.entries()) {
    const id = `cap-g${index + 1}`
    const group: SyntheticGroup = {
      id,
      slug: `cap-group-${index + 1}`,
      name: `Household ${index + 1}`,
      participants: members.map((_, j) => `${id}-p${j + 1}`),
      members,
    }
    const [creatorId] = members
    if (!creatorId) throw new Error(`Group ${id} has no members`)
    const creator = principal(creatorId, { name: nameOf.get(creatorId) ?? creatorId })
    await seedGroup(db, {
      groupId: group.id,
      slug: group.slug,
      name: group.name,
      people: members.map((m, j) => ({ id: group.participants[j] ?? '', name: nameOf.get(m) ?? m })),
      creator,
      members: [
        { userId: creatorId, participantId: group.participants[0] ?? null, role: 'admin' },
        ...members.slice(1).map((m, j) => ({ userId: m, participantId: group.participants[j + 1] ?? null, role: 'member' as const })),
      ],
    })
    const expenses = index % bigEvery === 0 ? 300 + Math.floor(random() * 201) : 10 + Math.floor(random() * 51)
    for (let k = 0; k < expenses; k++) {
      const payerIndex = Math.floor(random() * members.length)
      const payer = principal(members[payerIndex] ?? creatorId, { name: nameOf.get(members[payerIndex] ?? creatorId) ?? '' })
      const day = new Date(data.today.getTime() - Math.floor(random() * 365) * 86_400_000)
      const expense = draft({
        payer: group.participants[payerIndex] ?? '',
        people: group.participants,
        title: `${pick(random, ['Groceries', 'Dinner out', 'Electricity', 'Internet', 'Household supplies', 'Train tickets'])} ${k + 1}`,
        vendor: pick(random, ['Costco', "Trader Joe's", 'Safeway', 'PG&E', null]),
        amount: ((500 + Math.floor(random() * 20000)) / 100).toFixed(2),
        expenseDate: isoDay(day),
        notes: random() < 0.5 ? noteText(random) : '',
      })
      await serializable(db, (tx) => createExpense(tx, { principal: payer, groupId: group.id, expenseId: `${id}-e${k + 1}`, idempotencyKey: null, expense }))
    }
    groups.push(group)
    history.push(expenses)
  }

  const users = names.map((n, i): SyntheticUser => {
    const home = groups.find((g) => g.members.includes(n.userId))
    const at = home?.members.indexOf(n.userId) ?? -1
    const participantId = home?.participants[at]
    if (!home || !participantId) throw new Error(`${n.userId} is in no group`)
    // 10.x.y.z from the index: a distinct address for each person.
    return { ...n, ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, home, participantId }
  })
  return { users, groups, history }
}

/** A day's web session (the test kit's signed cookie) and a Better Auth API key, as Settings creates it, for each person. */
export async function credentials(db: Db, data: { users: readonly SyntheticUser[]; settings: AuthSettings }): Promise<ReadonlyMap<string, Credentials>> {
  const auth = createAuth({ ...data.settings, db })
  const found = new Map<string, Credentials>()
  for (const u of data.users) {
    const cookie = await signIn(db, { userId: u.userId, secret: data.settings.secret, baseUrl: data.settings.baseUrl })
    const { key } = await auth.api.createApiKey({ body: { userId: u.userId } })
    found.set(u.userId, { cookie, apiKey: key })
  }
  if (found.size !== data.users.length) throw new Error('A person has no credentials')
  return found
}
