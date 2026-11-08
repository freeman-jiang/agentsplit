// The second pass of MCP tools, over HTTP in process, against a real
// database: the feed, profile, group and access writes, balances, history,
// stats, export, reference data, recurrence and ungrouped creates. Parity
// items are named in docs/v2/parity/mcp.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SDK_INPUT_REFUSED } from '../kit/mcp'
import type { ExpenseCreateArgument } from '~/server/mcp/tools/expenses'
import { exportCsv, exportJson } from '~/server/export'
import { CURRENCY_CODES } from '~/shared/currencies'
import { mcpExpense } from '../kit/drafts'
import { principal } from '../kit/people'
import { id21 } from '../kit/ids'
import { checked as checkedCall, failure, type Harness, startHarness } from './harness'

let h: Harness
let alice: Record<string, string>

let expenseCount = 0
/** A new 21-character expense ID. */
const newExpenseId = () => id21('m', ++expenseCount)

// The fixtures stay as beforeAll makes them: a test that writes works in a household of its own.
beforeAll(async () => {
  h = await startHarness()
  await h.account('alice', { name: 'Alice' })
  await h.account('bob', { name: 'Bob' })
  await h.group({ id: 'g1', name: 'Home', people: ['pa', 'pb', 'pc'], members: [['alice', 'pa', 'admin'], ['bob', 'pb', 'member']] })
  await h.group({ id: 'g2', name: 'Bob only', people: ['qb'], members: [['bob', 'qb', 'admin']] })
  alice = { 'x-api-key': await h.apiKey('alice') }
})
afterAll(() => h.close())

/** A successful call whose result decodes with the tool's advertised output schema. */
const checked = (name: string, args: object, headers = alice) => checkedCall(h, { name, args, headers })

/** A new verified account with one API key. */
async function newAccount(userId: string, data: { name: string }) {
  await h.account(userId, { name: data.name })
  const { key, id } = await h.apiKeyWithId(userId)
  return { userId, headers: { 'x-api-key': key }, keyId: id }
}

/**
 * A group "Home" of its own for one test: new accounts for Alice (admin) and
 * Bob (member), bound to pa and pb, and an unbound placeholder pc.
 */
async function household(tag: string) {
  const owner = await newAccount(`${tag}-alice`, { name: 'Alice' })
  const member = await newAccount(`${tag}-bob`, { name: 'Bob' })
  const groupId = `${tag}-home`
  const [pa, pb, pc] = [`${tag}-pa`, `${tag}-pb`, `${tag}-pc`]
  await h.group({ id: groupId, name: 'Home', people: [pa, pb, pc], members: [[owner.userId, pa, 'admin'], [member.userId, pb, 'member']] })
  return { groupId, pa, pb, pc, owner, member }
}
type Household = Awaited<ReturnType<typeof household>>

/** Creates `expense` in `groupId` with a new expense ID. */
async function create(data: { groupId: string; headers: Record<string, string>; expense: ExpenseCreateArgument }) {
  const expenseId = newExpenseId()
  const result = await checked('create_expense', { groupId: data.groupId, expenseId, expense: data.expense }, data.headers)
  return { expenseId, result }
}

/** Alice pays 30 for herself and Bob on 1 November; Bob pays 12 for himself and pc on 2 November. */
async function seedFeed(hh: Household) {
  const { groupId, pa, pb, pc } = hh
  const groceries = await create({ groupId, headers: hh.owner.headers, expense: mcpExpense({ paidBy: pa, people: [pa, pb], title: 'Groceries' }) })
  const taxi = await create({ groupId, headers: hh.member.headers, expense: mcpExpense({ paidBy: pb, people: [pb, pc], title: 'Taxi', expenseDate: '2026-11-02', amount: '12' }) })
  return { groceries: groceries.expenseId, taxi: taxi.expenseId }
}

/** Bob pays 3000 yen for himself and Alice. */
const ramen = (hh: Household) =>
  create({ groupId: hh.groupId, headers: hh.owner.headers, expense: mcpExpense({ paidBy: hh.pb, people: [hh.pa, hh.pb], title: 'Ramen', currencyCode: 'JPY', amount: '3000' }) })

/** After seedFeed: Bob and pc pay Alice back 9 and 6 in one repayment. */
const settle = (hh: Household) =>
  create({
    groupId: hh.groupId,
    headers: hh.owner.headers,
    expense: mcpExpense({
      paidBy: null,
      people: [],
      title: 'Settle up',
      expenseDate: '2026-11-04',
      amount: '15',
      isReimbursement: true,
      payers: [{ participant: hh.pb, amount: '9' }, { participant: hh.pc, amount: '6' }],
      paidFor: [{ participant: hh.pa, shares: '15' }],
      splitMode: 'BY_AMOUNT',
    }),
  })

/** Alice's expense of 30 for herself and Bob, edited to 36: revision 1 and revision 2. */
async function createAndEdit(hh: Household) {
  const { expenseId } = await create({ groupId: hh.groupId, headers: hh.owner.headers, expense: mcpExpense({ paidBy: hh.pa, people: [hh.pa, hh.pb] }) })
  await checked('update_expense', { groupId: hh.groupId, expenseId, expectedRevision: 1, changes: { amount: '36' } }, hh.owner.headers)
  return expenseId
}

/** A private expense of 80 that `owner` paid, split with Erin, a new email invitee. */
async function privateExpense(owner: { userId: string; headers: Record<string, string> }) {
  const expenseId = newExpenseId()
  const email = `erin-${owner.userId}@example.com`
  const created = await checked(
    'create_expense',
    {
      expenseId,
      people: [
        { kind: 'account', id: 'me', userId: owner.userId },
        { kind: 'email', id: 'friend', name: 'Erin', email },
      ],
      expense: mcpExpense({ paidBy: 'me', people: ['me', 'friend'], title: 'Concert tickets', expenseDate: '2026-11-03', amount: '80', notes: '2 tickets × 40.00 = 80.00; each person pays 40.00' }),
    },
    owner.headers,
  )
  return { expenseId, email, created, me: `${expenseId}_me`, friend: `${expenseId}_friend` }
}

/** The friend pays the owner back 40 inside the private context. */
const repay = (data: { headers: Record<string, string>; context: Awaited<ReturnType<typeof privateExpense>> }) =>
  create({
    groupId: data.context.expenseId,
    headers: data.headers,
    expense: mcpExpense({ paidBy: data.context.friend, people: [data.context.me], title: 'Erin pays back', amount: '40', isReimbursement: true }),
  })

type Bucket = { currencyCode: string; balances: Record<string, { paid: string; paidFor: string; total: string }>; reimbursements: { from: string; to: string; amount: string }[] }

describe('feed and options', () => {
  it('lists only expenses involving the caller by default, and every accessible one on request', async () => {
    const hh = await household('feed')
    const { groceries, taxi } = await seedFeed(hh)
    // Bob pays for himself and pc: Alice is not involved.
    const mine = (await checked('list_all_expenses', {}, hh.owner.headers))['expenses'] as { id: string }[]
    expect(mine.map((e) => e.id)).toEqual([groceries])
    const all = (await checked('list_all_expenses', { involvingMe: false }, hh.owner.headers))['expenses'] as Record<string, unknown>[]
    expect(all.map((e) => e['id'])).toEqual([taxi, groceries])
    expect(all[1]).toMatchObject({
      groupId: hh.groupId,
      amount: '30.00',
      paidById: hh.pa,
      paidBy: { id: hh.pa, name: 'Alice' },
      paidFor: [{ participant: { id: hh.pa, name: 'Alice' }, shares: '1' }, { participant: { id: hh.pb, name: 'Bob' }, shares: '1' }],
      group: { id: hh.groupId, name: 'Home', slug: null },
      participantId: hh.pa,
      category: { id: 0 },
      attribution: { createdBy: { userId: hh.owner.userId, name: 'Alice', source: 'agent' } },
      deletedAt: null,
    })
  })

  it('pages with the returned cursor without skipping or repeating rows', async () => {
    const hh = await household('pages')
    const { groceries, taxi } = await seedFeed(hh)
    const first = await checked('list_all_expenses', { involvingMe: false, limit: 1 }, hh.owner.headers)
    const next = first['nextCursor'] as { date: string; createdAt: string; id: string }
    expect(next).toMatchObject({ date: '2026-11-02T00:00:00.000Z', id: taxi })
    const second = await checked('list_all_expenses', { involvingMe: false, limit: 1, cursor: next }, hh.owner.headers)
    expect((second['expenses'] as { id: string }[]).map((e) => e.id)).toEqual([groceries])
    expect(second['nextCursor']).toBeNull()
  })

  it('lists the caller, shared verified people and named groups only', async () => {
    const options = await checked('get_expense_options', {})
    expect(options).toEqual({
      userId: 'alice',
      groups: [{ id: 'g1', name: 'Home', slug: null }],
      people: [
        { id: 'alice', name: 'Alice', email: 'alice@example.com' },
        { id: 'bob', name: 'Bob', email: 'bob@example.com' },
      ],
    })
    expect((await failure(h, { name: 'get_expense_options', args: { userId: 'x' }, headers: alice })).code).toBe(SDK_INPUT_REFUSED)
  })
})

describe('ungrouped expenses', () => {
  it('creates a private expense with people and maps their labels to participants', async () => {
    const owner = await newAccount('private-alice', { name: 'Alice' })
    const { expenseId, email, created } = await privateExpense(owner)
    expect(created).toMatchObject({ groupId: expenseId, expenseId, revision: 1, amount: '80.00', currencyCode: 'USD' })
    expect(created['participants']).toEqual([
      { localId: 'me', participantId: `${expenseId}_me`, name: 'Alice' },
      { localId: 'friend', participantId: `${expenseId}_friend`, name: 'Erin' },
    ])
    expect((created['invitations'] as { email: string; url: string }[])[0]).toMatchObject({ email, url: expect.stringMatching(/^http:\/\/localhost\/invite\/[A-Za-z0-9_-]{43}$/) })
    const ungrouped = (await checked('list_all_expenses', { scope: 'ungrouped' }, owner.headers))['expenses'] as Record<string, unknown>[]
    expect(ungrouped).toHaveLength(1)
    expect(ungrouped[0]).toMatchObject({ id: expenseId, group: null, contextExpenseId: expenseId, contextExpenseTitle: 'Concert tickets', notes: '2 tickets × 40.00 = 80.00; each person pays 40.00' })
    // A retry with the same ID never creates a second private expense.
    const retry = await failure(h, {
      name: 'create_expense',
      args: {
        expenseId,
        people: [{ kind: 'account', id: 'me', userId: owner.userId }, { kind: 'email', id: 'b', name: 'Bea', email: 'bea@example.com' }],
        expense: mcpExpense({ paidBy: 'me', people: ['me', 'b'], title: 'Again', expenseDate: '2026-11-03', amount: '1' }),
      },
      headers: owner.headers,
    })
    expect(retry.code).toBe('CONFLICT')
  })

  it('records repayments inside the private context, and keeps its people fixed', async () => {
    const owner = await newAccount('repaid-alice', { name: 'Alice' })
    const context = await privateExpense(owner)
    const { expenseId, me } = context
    expect((await checked('get_group', { groupId: expenseId }, owner.headers))['context']).toEqual({ kind: 'ungrouped', expenseId })
    const repaid = await repay({ headers: owner.headers, context })
    expect(repaid.result).toMatchObject({ groupId: expenseId, revision: 1 })
    const widened = await failure(h, {
      name: 'update_expense',
      args: { groupId: expenseId, expenseId, expectedRevision: 1, changes: { paidFor: [{ participant: me, shares: '1' }] } },
      headers: owner.headers,
    })
    expect(widened).toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('cannot be changed') })
    // The original cannot go while its repayment is live.
    const deleted = await failure(h, { name: 'delete_expense', args: { groupId: expenseId, expenseId, expectedRevision: 1 }, headers: owner.headers })
    expect(deleted).toMatchObject({ code: 'CONFLICT', message: 'Remove this expense’s recorded repayments before deleting the expense.' })
  })
})

describe('profile', () => {
  it('renames only the caller, at once in current views, and keeps old audit names', async () => {
    const hh = await household('profile')
    const { groceries } = await seedFeed(hh)
    const { headers, userId } = hh.owner
    const renamed = await checked('update_profile', { name: '  Alicia  ' }, headers)
    expect(renamed).toEqual({ profile: { id: userId, name: 'Alicia', email: `${userId}@example.com`, emailVerified: true } })
    const feed = (await checked('list_all_expenses', { groupId: hh.groupId }, headers))['expenses'] as { id: string; paidBy: { name: string }; paidFor: { participant: { name: string } }[] }[]
    const row = feed.find((e) => e.id === groceries)
    expect(row?.paidBy.name).toBe('Alicia')
    expect(row?.paidFor.map((p) => p.participant.name)).toEqual(['Alicia', 'Bob'])
    const log = (await checked('list_activity', { groupId: hh.groupId, expenseId: groceries }, headers))['activities'] as { actorName: string }[]
    expect(log[0]?.actorName).toBe('Alice')
    expect((await failure(h, { name: 'update_profile', args: { name: ' ' }, headers })).code).toBe('BAD_REQUEST')
    expect((await failure(h, { name: 'update_profile', args: { name: 'X', userId: hh.member.userId }, headers })).code).toBe(SDK_INPUT_REFUSED)
  })
})

describe('groups and access', () => {
  it('creates a group with the creator as admin and refuses a reused ID as a conflict', async () => {
    const { headers } = await newAccount('creator', { name: 'Alice' })
    const groupId = 'G'.repeat(21)
    const created = await checked('create_group', { groupId, group: { name: 'Trip', currency: '€', currencyCode: 'EUR', participants: [{ name: 'Sam' }] } }, headers)
    expect(created).toMatchObject({ groupId, group: { id: groupId, name: 'Trip', revision: 1, currency: '€', currencyCode: 'EUR', information: null, slug: null } })
    expect((created['group'] as { participants: { name: string }[] }).participants.map((p) => p.name)).toEqual(['Alice', 'Sam'])
    const again = await failure(h, { name: 'create_group', args: { groupId, group: { name: 'Trip', currency: '€', participants: [] } }, headers })
    expect(again).toMatchObject({ code: 'CONFLICT', message: 'Group ID is already in use; read it before retrying or choose a new ID' })
    // A custom symbol has no registered currency.
    const custom = await failure(h, { name: 'create_group', args: { group: { name: 'Odd', currency: '¤', participants: [] } }, headers })
    expect(custom.code).toBe('BAD_REQUEST')
    const seen = (await checked('list_groups', {}, headers))['groups'] as { id: string }[]
    expect(seen.map((g) => g.id)).toEqual([groupId])
  })

  it('edits as admin with the current revision only', async () => {
    const hh = await household('edit')
    const before = await checked('get_group', { groupId: hh.groupId }, hh.owner.headers)
    const revision = (before['group'] as { revision: number }).revision
    const people = (before['group'] as { participants: { id: string; name: string }[] }).participants
    const updated = await checked('update_group', { groupId: hh.groupId, expectedRevision: revision, changes: { name: 'Home sweet home', participants: [...people, { name: 'Dave' }] } }, hh.owner.headers)
    expect(updated).toMatchObject({ groupId: hh.groupId, group: { name: 'Home sweet home', revision: revision + 1 } })
    expect((updated['group'] as { participants: { name: string }[] }).participants.map((p) => p.name)).toEqual([...people.map((p) => p.name), 'Dave'])
    const stale = await failure(h, { name: 'update_group', args: { groupId: hh.groupId, expectedRevision: revision, changes: { name: 'Lost' } }, headers: hh.owner.headers })
    expect(stale).toMatchObject({ code: 'CONFLICT', recovery: 'read_current_revision' })
    const member = await failure(h, { name: 'update_group', args: { groupId: hh.groupId, expectedRevision: revision + 1, changes: { name: 'Mine' } }, headers: hh.member.headers })
    expect(member).toMatchObject({ code: 'FORBIDDEN', message: 'Only group admins can edit group settings' })
  })

  it('invites by email, joins with the link, and answers joined only for a join', async () => {
    const hh = await household('invite')
    const { groupId, pc } = hh
    const owner = hh.owner.headers
    const dave = await newAccount('invite-dave', { name: 'Dave' })
    expect((await failure(h, { name: 'manage_group_access', args: { action: 'invite', groupId }, headers: owner })).message).toContain('email is required')
    const invited = await checked('manage_group_access', { action: 'invite', groupId, email: 'Invite-Dave@Example.com', participantId: pc }, owner)
    const invitation = invited['invitation'] as { url: string; email: string; participantId: string }
    expect(invited['joined']).toBe(false)
    expect(invitation).toMatchObject({ email: 'invite-dave@example.com', participantId: pc })
    const groupUrl = await failure(h, { name: 'manage_group_access', args: { action: 'join', shareUrl: `http://localhost/groups/${groupId}` }, headers: dave.headers })
    expect(groupUrl.code).toBe('BAD_REQUEST')
    const joined = await checked('manage_group_access', { action: 'join', shareUrl: invitation.url }, dave.headers)
    expect(joined).toEqual({ groupId, joined: true })
    expect((await checked('get_group', { groupId }, dave.headers))['access']).toMatchObject({ participantId: pc, role: 'member' })
    const left = await checked('manage_group_access', { action: 'leave', groupId }, dave.headers)
    expect(left).toEqual({ groupId, joined: false })
    // State conflicts answer CONFLICT, as in v1 (P-TOOL-ACCESS-10, P-TOOL-ACCESS-20).
    const reused = await failure(h, { name: 'manage_group_access', args: { action: 'join', shareUrl: invitation.url }, headers: dave.headers })
    expect(reused).toEqual({ code: 'CONFLICT', message: 'Invitation already used', outcomeUnknown: false, recovery: 'read_current_revision' })
    const lastAdmin = await failure(h, { name: 'manage_group_access', args: { action: 'leave', groupId }, headers: owner })
    expect(lastAdmin).toMatchObject({ code: 'CONFLICT', message: 'Choose another admin before removing or demoting the last admin' })
    const gone = await failure(h, { name: 'manage_group_access', args: { action: 'remove_member', groupId, userId: dave.userId }, headers: owner })
    expect(gone).toMatchObject({ code: 'NOT_FOUND', message: 'Member not found' })
    const revoked = await failure(h, { name: 'manage_group_access', args: { action: 'revoke_invitation', groupId, invitationId: 'nope' }, headers: owner })
    expect(revoked).toMatchObject({ code: 'NOT_FOUND', message: 'Pending invitation not found' })
  })

  it('renews the original invitation of a private expense', async () => {
    const owner = await newAccount('renew-alice', { name: 'Alice' })
    const { expenseId, email, friend } = await privateExpense(owner)
    const renewed = await checked('manage_group_access', { action: 'renew_invitation', groupId: expenseId, participantId: friend }, owner.headers)
    expect(renewed['invitation']).toMatchObject({ email, participantName: 'Erin', url: expect.stringContaining('/invite/') })
    // A named group has no original invitation to renew, even for its admin.
    const named = await failure(h, { name: 'manage_group_access', args: { action: 'renew_invitation', groupId: 'g1', participantId: 'pc' }, headers: alice })
    expect(named).toMatchObject({ code: 'FORBIDDEN', message: 'Only the expense creator can reissue its original invitations.' })
  })
})

describe('balances', () => {
  it('derives public balances from the suggested repayments, per currency', async () => {
    const hh = await household('balances')
    const { groupId, pa, pb, pc } = hh
    await seedFeed(hh)
    await ramen(hh)
    const result = await checked('get_balances', { groupId }, hh.owner.headers)
    const [jpy, usd] = result['currencies'] as Bucket[]
    expect(jpy).toEqual({ currencyCode: 'JPY', balances: { [pa]: { paid: '0', paidFor: '1500', total: '-1500' }, [pb]: { paid: '1500', paidFor: '0', total: '1500' } }, reimbursements: [{ from: pa, to: pb, amount: '1500' }] })
    // USD: Alice paid 30 for Alice and Bob; Bob paid 12 for Bob and pc.
    expect(usd?.reimbursements).toEqual([
      { from: pc, to: pa, amount: '6.00' },
      { from: pb, to: pa, amount: '9.00' },
    ])
    expect(usd?.balances[pa]).toEqual({ paid: '15.00', paidFor: '0.00', total: '15.00' })
    const only = await checked('get_balances', { groupId, currencyCode: 'JPY' }, hh.owner.headers)
    expect((only['currencies'] as Bucket[]).map((c) => c.currencyCode)).toEqual(['JPY'])
  })

  it('records a repayment with several people, after which nothing is suggested', async () => {
    const hh = await household('settle')
    await seedFeed(hh)
    await settle(hh)
    const usd = ((await checked('get_balances', { groupId: hh.groupId, currencyCode: 'USD' }, hh.owner.headers))['currencies'] as Bucket[])[0]
    expect(usd).toEqual({ currencyCode: 'USD', balances: {}, reimbursements: [] })
  })

  it('reads balances as of an earlier recorded change', async () => {
    const hh = await household('past')
    const { groupId } = hh
    const headers = hh.owner.headers
    await seedFeed(hh)
    const { expenseId } = await settle(hh)
    const log = (await checked('list_activity', { groupId, expenseId }, headers))['activities'] as { id: string }[]
    const before = (await checked('list_activity', { groupId, limit: 1, atActivityId: log[0]?.id ?? '', order: 'desc', cursor: 1 }, headers))['activities'] as { id: string }[]
    const past = await checked('get_balances', { groupId, currencyCode: 'USD', atActivityId: before[0]?.id ?? '' }, headers)
    expect(past['history']).toMatchObject({ atActivityId: before[0]?.id, complete: true, unavailableExpenseIds: [] })
    expect(((past['currencies'] as Bucket[])[0]?.reimbursements ?? []).length).toBe(2)
    const precise = await failure(h, { name: 'get_balances', args: { groupId, asOf: '2026-11-01T00:00:00.0001Z' }, headers })
    expect(precise.code).toBe(SDK_INPUT_REFUSED)
    const future = await failure(h, { name: 'get_balances', args: { groupId, asOf: '2999-01-01T00:00:00Z' }, headers })
    expect(future).toMatchObject({ code: 'BAD_REQUEST', message: 'asOf cannot be in the future' })
  })

  it('sums account balances per currency, restricts the scope, and refuses a foreign group or participant', async () => {
    const hh = await household('totals')
    const { groupId, pb } = hh
    const headers = hh.owner.headers
    await seedFeed(hh)
    await ramen(hh)
    await settle(hh)
    const context = await privateExpense(hh.owner)
    await repay({ headers, context })
    const all = await checked('get_participant_balances', {}, headers)
    // The private expense is repaid, so only the named group counts.
    expect(all['totals']).toEqual([
      { currencyCode: 'JPY', amount: '-1500' },
      { currencyCode: 'USD', amount: '0.00' },
    ])
    expect((all['balances'] as { groupId: string; currency: string }[]).find((b) => b.groupId === context.expenseId)).toMatchObject({ currency: '$', amount: '0.00' })
    const bobView = await checked('get_participant_balances', { groups: [{ groupId, participantId: pb }] }, headers)
    expect(bobView['totals']).toEqual([
      { currencyCode: 'JPY', amount: '1500' },
      { currencyCode: 'USD', amount: '0.00' },
    ])
    const denied = await failure(h, { name: 'get_participant_balances', args: { groups: [{ groupId }, { groupId: 'g2' }] }, headers })
    expect(denied.code).toBe('FORBIDDEN')
    const foreign = await failure(h, { name: 'get_participant_balances', args: { groups: [{ groupId, participantId: 'qb' }] }, headers })
    expect(foreign).toMatchObject({ code: 'BAD_REQUEST', message: 'Participant does not belong to this group.' })
    const twice = await failure(h, { name: 'get_participant_balances', args: { groups: [{ groupId }, { groupId }] }, headers })
    expect(twice.message).toContain('Choose each group or private context only once.')
  })
})

describe('history', () => {
  it('shows agent writes with their actor, and the key ID only to its owner', async () => {
    const hh = await household('actor')
    const { groupId, pa } = hh
    const id = await createAndEdit(hh)
    const mine = (await checked('list_activity', { groupId, expenseId: id, order: 'asc' }, hh.owner.headers))['activities'] as Record<string, unknown>[]
    expect(mine.map((a) => a['activityType'])).toEqual(['CREATE_EXPENSE', 'UPDATE_EXPENSE'])
    expect(mine[1]).toMatchObject({ source: 'agent', actorUserId: hh.owner.userId, agentKeyId: hh.owner.keyId, expenseRevision: 2, expense: { id, amount: '36.00', revision: 2 } })
    expect(mine[1]?.['snapshot']).toMatchObject({ kind: 'expense', group: { id: groupId }, expense: { amount: '36.00', paidBy: { id: pa } } })
    expect(mine[1]?.['previousSnapshot']).toMatchObject({ expense: { amount: '30.00' } })
    const seenByBob = (await checked('list_activity', { groupId, expenseId: id, order: 'asc' }, hh.member.headers))['activities'] as Record<string, unknown>[]
    expect(seenByBob[1]).toMatchObject({ actorUserId: hh.owner.userId, agentKeyId: null })
  })

  it('keeps pages fixed at the returned boundary and leaves out live state there', async () => {
    const hh = await household('boundary')
    const { groupId, pa } = hh
    const headers = hh.owner.headers
    await seedFeed(hh)
    await settle(hh)
    const first = await checked('list_activity', { groupId, limit: 2 }, headers)
    const boundary = first['atActivityId'] as string
    await create({ groupId, headers, expense: mcpExpense({ paidBy: pa, people: [pa], title: 'Late', amount: '1' }) })
    const again = await checked('list_activity', { groupId, limit: 2, atActivityId: boundary }, headers)
    expect(again['activities']).toEqual((first['activities'] as Record<string, unknown>[]).map(({ expense: _live, ...rest }) => rest))
    const foreign = await failure(h, { name: 'list_activity', args: { groupId, atActivityId: 'no-such-event' }, headers })
    expect(foreign).toMatchObject({ code: 'NOT_FOUND', message: 'History boundary not found in this group' })
  })

  it('reads a saved revision and a historical list without live values', async () => {
    const hh = await household('revision')
    const { groupId } = hh
    const headers = hh.owner.headers
    const id = await createAndEdit(hh)
    const old = await checked('get_expense', { groupId, expenseId: id, revision: 1 }, headers)
    expect(old['expense']).toMatchObject({ amount: '30.00', revision: 1, deletedAt: null, recurringExpenseLink: null, attribution: { createdBy: { userId: hh.owner.userId }, updatedBy: null } })
    expect(old['history']).toMatchObject({ revision: 1, deleted: false, snapshot: { kind: 'expense', expense: { amount: '30.00' } } })
    const log = (await checked('list_activity', { groupId, expenseId: id, order: 'asc' }, headers))['activities'] as { id: string }[]
    const list = await checked('list_expenses', { groupId, atActivityId: log[0]?.id ?? '', limit: 100 }, headers)
    expect(list['history']).toMatchObject({ atActivityId: log[0]?.id, complete: true })
    expect((list['expenses'] as { id: string; amount: string }[]).find((e) => e.id === id)?.amount).toBe('30.00')
  })
})

describe('stats, export, reference data and recurrence', () => {
  it('reports stats in one currency, for a chosen participant', async () => {
    const hh = await household('stats')
    const { groupId, pa, pb } = hh
    const headers = hh.owner.headers
    await seedFeed(hh)
    await create({ groupId, headers, expense: mcpExpense({ paidBy: pa, people: [pa], title: 'Late', amount: '1' }) })
    await settle(hh)
    await ramen(hh)
    const stats = await checked('get_spending_stats', { groupId, currencyCode: 'USD', participantId: pb, from: '2026-11-01', to: '2026-11-30' }, headers)
    // Spending is 30 + 12 + 1; the repayment is not spending. Bob's share is 15 + 6.
    expect(stats).toMatchObject({ currencyCode: 'USD', availableCurrencyCodes: ['JPY', 'USD'], totalGroupSpendings: '43.00', totalParticipantSpendings: '12.00', totalParticipantShare: '21.00' })
    expect(stats['summary']).toMatchObject({ expenseCount: 3, totalSpending: '43.00' })
    const plain = await checked('get_spending_stats', { groupId }, headers)
    expect(plain).not.toHaveProperty('totalParticipantSpendings')
  })

  it('exports the group with the content of the web exports', async () => {
    const web = { principal: principal('alice'), groupId: 'g1' }
    const json = await checked('export_group', { groupId: 'g1' })
    expect(json).toMatchObject({ filename: 'agentsplit-g1.json', contentType: 'application/json' })
    expect(JSON.parse(json['content'] as string)).toEqual(JSON.parse((await h.withDb((db) => exportJson(db, web))).content))
    const csv = await checked('export_group', { groupId: 'g1', format: 'csv' })
    expect(csv).toMatchObject({ filename: 'agentsplit-g1.csv', contentType: 'text/csv' })
    expect(csv['content']).toBe((await h.withDb((db) => exportCsv(db, web))).content)
    expect((await failure(h, { name: 'export_group', args: { groupId: 'g2' }, headers: alice })).code).toBe('FORBIDDEN')
  })

  it('lists reference data in the current names', async () => {
    const reference = await checked('get_reference_data', {})
    expect(reference['splitModes']).toEqual(['EVENLY', 'BY_SHARES', 'BY_PERCENTAGE', 'BY_AMOUNT'])
    expect(reference['recurrenceRules']).toEqual(['NONE', 'DAILY', 'WEEKLY', 'MONTHLY'])
    expect((reference['currencies'] as { code: string; decimalPlaces: number }[]).find((c) => c.code === 'JPY')?.decimalPlaces).toBe(0)
    expect(reference['currencies']).toHaveLength(CURRENCY_CODES.length)
  })

  it('creates due occurrences only in the given group, once', async () => {
    const hh = await household('recurring')
    const { groupId, pa } = hh
    const headers = hh.owner.headers
    const start = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)
    const coffee = (data: { groupId: string; payer: string }) =>
      create({ groupId: data.groupId, headers, expense: mcpExpense({ paidBy: data.payer, people: [data.payer], title: 'Coffee', expenseDate: start, amount: '3', recurrenceRule: 'DAILY' }) })
    const coffees = async (id: string) => ((await checked('list_expenses', { groupId: id, filter: 'Coffee' }, headers))['expenses'] as unknown[]).length
    // The same owner's other group has a series that is due too.
    const other = `${groupId}-other`
    await h.group({ id: other, people: [`${other}-pa`], members: [[hh.owner.userId, `${other}-pa`, 'admin']] })
    await coffee({ groupId, payer: pa })
    await coffee({ groupId: other, payer: `${other}-pa` })
    expect(await coffees(groupId)).toBe(1)
    const denied = await failure(h, { name: 'process_recurring_expenses', args: { groupId: 'g2' }, headers })
    expect(denied.code).toBe('FORBIDDEN')
    const processed = await checked('process_recurring_expenses', { groupId }, headers)
    expect(processed['createdExpenseIds']).toHaveLength(2)
    expect(await checked('process_recurring_expenses', { groupId }, headers)).toEqual({ createdExpenseIds: [] })
    expect(await coffees(other)).toBe(1)
  })
})
