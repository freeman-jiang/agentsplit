// The second pass of MCP tools, over HTTP in process, against a real
// database: the feed, profile, group and access writes, balances, history,
// stats, export, reference data, recurrence and ungrouped creates. Parity
// items are named in docs/v2/parity/mcp.md.
import { Schema } from 'effect'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MCP_TOOLS } from '~/server/mcp/tools'
import { failure, ok, startHarness, type Harness } from './mcp-harness'

let h: Harness
let alice: Record<string, string>
let bob: Record<string, string>
let dave: Record<string, string>
let aliceKeyId: string

const id21 = (n: number) => `m${String(n).padStart(20, '0')}`

beforeAll(async () => {
  h = await startHarness()
  await h.account('alice', { name: 'Alice' })
  await h.account('bob', { name: 'Bob' })
  await h.account('dave', { name: 'Dave' })
  await h.group({ id: 'g1', name: 'Home', people: ['pa', 'pb', 'pc'], members: [['alice', 'pa', 'admin'], ['bob', 'pb', 'member']] })
  await h.group({ id: 'g2', name: 'Bob only', people: ['qb'], members: [['bob', 'qb', 'admin']] })
  alice = { 'x-api-key': await h.apiKey('alice') }
  bob = { 'x-api-key': await h.apiKey('bob') }
  dave = { 'x-api-key': await h.apiKey('dave') }
  const keys = await h.withDb((db) => db.execute<{ id: string }>(sql`SELECT id FROM apikey WHERE reference_id = 'alice'`))
  aliceKeyId = keys.rows[0]?.id ?? ''
})
afterAll(() => h.close())

const tool = (name: string) => {
  const found = MCP_TOOLS.find((t) => t.name === name)
  if (!found) throw new Error(name)
  return found
}
/** Every result must decode with the tool's advertised output schema. */
const checked = async (name: string, args: object, headers = alice) => {
  const result = await ok(h, { name, args, headers })
  Schema.decodeUnknownSync(tool(name).output as Schema.Codec<unknown>)(result)
  return result
}

const create = (data: { id: number; group?: string; headers?: Record<string, string>; expense: Record<string, unknown> }) =>
  checked(
    'create_expense',
    {
      groupId: data.group ?? 'g1',
      expenseId: id21(data.id),
      expense: { title: 'Dinner', expenseDate: '2026-11-01', currencyCode: 'USD', isReimbursement: false, ...data.expense },
    },
    data.headers ?? alice,
  )

type Bucket = { currencyCode: string; balances: Record<string, { paid: string; paidFor: string; total: string }>; reimbursements: { from: string; to: string; amount: string }[] }

describe('feed and options', () => {
  it('lists only expenses involving the caller by default, and every accessible one on request', async () => {
    await create({ id: 1, expense: { title: 'Groceries', amount: '30', paidBy: 'pa', paidFor: [{ participant: 'pa', shares: '1' }, { participant: 'pb', shares: '1' }] } })
    // Bob pays for himself and Carol's placeholder: Alice is not involved.
    await create({ id: 2, headers: bob, expense: { title: 'Taxi', expenseDate: '2026-11-02', amount: '12', paidBy: 'pb', paidFor: [{ participant: 'pb', shares: '1' }, { participant: 'pc', shares: '1' }] } })
    const mine = (await checked('list_all_expenses', {}))['expenses'] as { id: string }[]
    expect(mine.map((e) => e.id)).toEqual([id21(1)])
    const all = (await checked('list_all_expenses', { involvingMe: false }))['expenses'] as Record<string, unknown>[]
    expect(all.map((e) => e['id'])).toEqual([id21(2), id21(1)])
    expect(all[1]).toMatchObject({
      groupId: 'g1',
      amount: '30.00',
      paidById: 'pa',
      paidBy: { id: 'pa', name: 'Alice' },
      paidFor: [{ participant: { id: 'pa', name: 'Alice' }, shares: '1' }, { participant: { id: 'pb', name: 'Bob' }, shares: '1' }],
      group: { id: 'g1', name: 'Home', slug: null },
      participantId: 'pa',
      category: { id: 0 },
      attribution: { createdBy: { userId: 'alice', name: 'Alice', source: 'agent' } },
      deletedAt: null,
    })
  })

  it('pages with the returned cursor without skipping or repeating rows', async () => {
    const first = await checked('list_all_expenses', { involvingMe: false, limit: 1 })
    const next = first['nextCursor'] as { date: string; createdAt: string; id: string }
    expect(next).toMatchObject({ date: '2026-11-02T00:00:00.000Z', id: id21(2) })
    const second = await checked('list_all_expenses', { involvingMe: false, limit: 1, cursor: next })
    expect((second['expenses'] as { id: string }[]).map((e) => e.id)).toEqual([id21(1)])
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
    expect((await failure(h, { name: 'get_expense_options', args: { userId: 'x' }, headers: alice })).code).toBe('VALIDATION')
  })
})

describe('ungrouped expenses', () => {
  it('creates a private expense with people and maps their labels to participants', async () => {
    const created = await checked('create_expense', {
      expenseId: id21(10),
      people: [
        { kind: 'account', id: 'me', userId: 'alice' },
        { kind: 'email', id: 'friend', name: 'Erin', email: 'erin@example.com' },
      ],
      expense: {
        title: 'Concert tickets',
        expenseDate: '2026-11-03',
        currencyCode: 'USD',
        amount: '80',
        paidBy: 'me',
        paidFor: [{ participant: 'me', shares: '1' }, { participant: 'friend', shares: '1' }],
        isReimbursement: false,
        notes: '2 tickets × 40.00 = 80.00; each person pays 40.00',
      },
    })
    expect(created).toMatchObject({ groupId: id21(10), expenseId: id21(10), revision: 1, amount: '80.00', currencyCode: 'USD' })
    expect(created['participants']).toEqual([
      { localId: 'me', participantId: `${id21(10)}_me`, name: 'Alice' },
      { localId: 'friend', participantId: `${id21(10)}_friend`, name: 'Erin' },
    ])
    expect((created['invitations'] as { email: string; url: string }[])[0]).toMatchObject({ email: 'erin@example.com', url: expect.stringMatching(/^http:\/\/localhost\/invite\/[A-Za-z0-9_-]{43}$/) })
    const ungrouped = (await checked('list_all_expenses', { scope: 'ungrouped' }))['expenses'] as Record<string, unknown>[]
    expect(ungrouped).toHaveLength(1)
    expect(ungrouped[0]).toMatchObject({ id: id21(10), group: null, contextExpenseId: id21(10), contextExpenseTitle: 'Concert tickets', notes: '2 tickets × 40.00 = 80.00; each person pays 40.00' })
    // A retry with the same ID never creates a second private expense.
    const retry = await failure(h, {
      name: 'create_expense',
      args: { expenseId: id21(10), people: [{ kind: 'account', id: 'me', userId: 'alice' }, { kind: 'account', id: 'b', userId: 'bob' }], expense: { title: 'Again', expenseDate: '2026-11-03', currencyCode: 'USD', amount: '1', paidBy: 'me', paidFor: [{ participant: 'me', shares: '1' }, { participant: 'b', shares: '1' }], isReimbursement: false } },
      headers: alice,
    })
    expect(retry.code).toBe('CONFLICT')
  })

  it('records repayments inside the private context, and keeps its people fixed', async () => {
    const context = await checked('get_group', { groupId: id21(10) })
    expect(context['context']).toEqual({ kind: 'ungrouped', expenseId: id21(10) })
    const [me, friend] = [`${id21(10)}_me`, `${id21(10)}_friend`]
    const repaid = await create({ id: 11, group: id21(10), expense: { title: 'Erin pays back', amount: '40', paidBy: friend, paidFor: [{ participant: me, shares: '1' }], isReimbursement: true } })
    expect(repaid).toMatchObject({ groupId: id21(10), revision: 1 })
    const widened = await failure(h, {
      name: 'update_expense',
      args: { groupId: id21(10), expenseId: id21(10), expectedRevision: 1, changes: { paidFor: [{ participant: me, shares: '1' }] } },
      headers: alice,
    })
    expect(widened).toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('cannot be changed') })
    // The original cannot go while its repayment is live.
    const deleted = await failure(h, { name: 'delete_expense', args: { groupId: id21(10), expenseId: id21(10), expectedRevision: 1 }, headers: alice })
    expect(deleted).toMatchObject({ code: 'CONFLICT', message: 'Remove this expense’s recorded repayments before deleting the expense.' })
  })
})

describe('profile', () => {
  it('renames only the caller, at once in current views, and keeps old audit names', async () => {
    const renamed = await checked('update_profile', { name: '  Alicia  ' })
    expect(renamed).toEqual({ profile: { id: 'alice', name: 'Alicia', email: 'alice@example.com', emailVerified: true } })
    const row = ((await checked('list_all_expenses', { groupId: 'g1' }))['expenses'] as { paidBy: { name: string } }[])[0]
    expect(row?.paidBy.name).toBe('Alicia')
    const log = (await checked('list_activity', { groupId: 'g1', expenseId: id21(1) }))['activities'] as { actorName: string }[]
    expect(log[0]?.actorName).toBe('Alice')
    expect((await failure(h, { name: 'update_profile', args: { name: ' ' }, headers: alice })).code).toBe('BAD_REQUEST')
    expect((await failure(h, { name: 'update_profile', args: { name: 'X', userId: 'bob' }, headers: alice })).code).toBe('VALIDATION')
    await checked('update_profile', { name: 'Alice' })
  })
})

describe('groups and access', () => {
  it('creates a group with the creator as admin and refuses a reused ID as a conflict', async () => {
    const groupId = 'G'.repeat(21)
    const created = await checked('create_group', { groupId, group: { name: 'Trip', currency: '€', currencyCode: 'EUR', participants: [{ name: 'Sam' }] } })
    expect(created).toMatchObject({ groupId, group: { id: groupId, name: 'Trip', revision: 1, currency: '€', currencyCode: 'EUR', information: null, slug: null } })
    expect((created['group'] as { participants: { name: string }[] }).participants.map((p) => p.name)).toEqual(['Alice', 'Sam'])
    const again = await failure(h, { name: 'create_group', args: { groupId, group: { name: 'Trip', currency: '€', participants: [] } }, headers: alice })
    expect(again).toMatchObject({ code: 'CONFLICT', message: 'Group ID is already in use; read it before retrying or choose a new ID' })
    // A custom symbol has no registered currency.
    const custom = await failure(h, { name: 'create_group', args: { group: { name: 'Odd', currency: '¤', participants: [] } }, headers: alice })
    expect(custom.code).toBe('BAD_REQUEST')
    const seen = (await checked('list_groups', {}))['groups'] as { id: string }[]
    expect(seen.map((g) => g.id)).toContain(groupId)
  })

  it('edits as admin with the current revision only', async () => {
    const before = await checked('get_group', { groupId: 'g1' })
    const revision = (before['group'] as { revision: number }).revision
    const people = (before['group'] as { participants: { id: string; name: string }[] }).participants
    const updated = await checked('update_group', { groupId: 'g1', expectedRevision: revision, changes: { name: 'Home sweet home', participants: [...people, { name: 'Dave' }] } })
    expect(updated).toMatchObject({ groupId: 'g1', group: { name: 'Home sweet home', revision: revision + 1 } })
    const stale = await failure(h, { name: 'update_group', args: { groupId: 'g1', expectedRevision: revision, changes: { name: 'Lost' } }, headers: alice })
    expect(stale).toMatchObject({ code: 'CONFLICT', recovery: 'read_current_revision' })
    const member = await failure(h, { name: 'update_group', args: { groupId: 'g1', expectedRevision: revision + 1, changes: { name: 'Mine' } }, headers: bob })
    expect(member).toMatchObject({ code: 'FORBIDDEN', message: 'Only group admins can edit group settings' })
  })

  it('invites by email, joins with the link, and answers joined only for a join', async () => {
    const group = await checked('get_group', { groupId: 'g1' })
    const daveParticipant = (group['group'] as { participants: { id: string; name: string }[] }).participants.find((p) => p.name === 'Dave')?.id ?? ''
    expect((await failure(h, { name: 'manage_group_access', args: { action: 'invite', groupId: 'g1' }, headers: alice })).message).toContain('email is required')
    const invited = await checked('manage_group_access', { action: 'invite', groupId: 'g1', email: 'Dave@Example.com', participantId: daveParticipant })
    const invitation = invited['invitation'] as { url: string; email: string; participantId: string }
    expect(invited['joined']).toBe(false)
    expect(invitation).toMatchObject({ email: 'dave@example.com', participantId: daveParticipant })
    const groupUrl = await failure(h, { name: 'manage_group_access', args: { action: 'join', shareUrl: 'http://localhost/groups/g1' }, headers: dave })
    expect(groupUrl.code).toBe('BAD_REQUEST')
    const joined = await checked('manage_group_access', { action: 'join', shareUrl: invitation.url }, dave)
    expect(joined).toEqual({ groupId: 'g1', joined: true })
    expect((await checked('get_group', { groupId: 'g1' }, dave))['access']).toMatchObject({ participantId: daveParticipant, role: 'member' })
    const left = await checked('manage_group_access', { action: 'leave', groupId: 'g1' }, dave)
    expect(left).toEqual({ groupId: 'g1', joined: false })
    // State conflicts answer CONFLICT, as in the current app (P-TOOL-ACCESS-10, P-TOOL-ACCESS-20).
    const reused = await failure(h, { name: 'manage_group_access', args: { action: 'join', shareUrl: invitation.url }, headers: dave })
    expect(reused).toEqual({ code: 'CONFLICT', message: 'Invitation already used', outcomeUnknown: false, recovery: 'read_current_revision' })
    const lastAdmin = await failure(h, { name: 'manage_group_access', args: { action: 'leave', groupId: 'g1' }, headers: alice })
    expect(lastAdmin).toMatchObject({ code: 'CONFLICT', message: 'Choose another admin before removing or demoting the last admin' })
    const gone = await failure(h, { name: 'manage_group_access', args: { action: 'remove_member', groupId: 'g1', userId: 'dave' }, headers: alice })
    expect(gone).toMatchObject({ code: 'NOT_FOUND', message: 'Member not found' })
    const revoked = await failure(h, { name: 'manage_group_access', args: { action: 'revoke_invitation', groupId: 'g1', invitationId: 'nope' }, headers: alice })
    expect(revoked).toMatchObject({ code: 'NOT_FOUND', message: 'Pending invitation not found' })
  })

  it('renews the original invitation of a private expense', async () => {
    const renewed = await checked('manage_group_access', { action: 'renew_invitation', groupId: id21(10), participantId: `${id21(10)}_friend` })
    expect(renewed['invitation']).toMatchObject({ email: 'erin@example.com', participantName: 'Erin', url: expect.stringContaining('/invite/') })
    const byOther = await failure(h, { name: 'manage_group_access', args: { action: 'renew_invitation', groupId: 'g1', participantId: 'pc' }, headers: alice })
    expect(byOther.code).toBe('FORBIDDEN')
  })
})

describe('balances', () => {
  it('derives public balances from the suggested repayments, per currency', async () => {
    await create({ id: 20, expense: { title: 'Ramen', currencyCode: 'JPY', amount: '3000', paidBy: 'pb', paidFor: [{ participant: 'pa', shares: '1' }, { participant: 'pb', shares: '1' }] } })
    const result = await checked('get_balances', { groupId: 'g1' })
    const [jpy, usd] = result['currencies'] as Bucket[]
    expect(jpy).toEqual({ currencyCode: 'JPY', balances: { pa: { paid: '0', paidFor: '1500', total: '-1500' }, pb: { paid: '1500', paidFor: '0', total: '1500' } }, reimbursements: [{ from: 'pa', to: 'pb', amount: '1500' }] })
    // USD: Alice paid 30 for Alice and Bob; Bob paid 12 for Bob and Carol's placeholder.
    expect(usd?.reimbursements).toEqual([
      { from: 'pc', to: 'pa', amount: '6.00' },
      { from: 'pb', to: 'pa', amount: '9.00' },
    ])
    expect(usd?.balances['pa']).toEqual({ paid: '15.00', paidFor: '0.00', total: '15.00' })
    const only = await checked('get_balances', { groupId: 'g1', currencyCode: 'JPY' })
    expect((only['currencies'] as Bucket[]).map((c) => c.currencyCode)).toEqual(['JPY'])
  })

  it('records a repayment with several people, after which nothing is suggested', async () => {
    await create({
      id: 21,
      expense: {
        title: 'Settle up',
        expenseDate: '2026-11-04',
        amount: '15',
        payers: [{ participant: 'pb', amount: '9' }, { participant: 'pc', amount: '6' }],
        paidFor: [{ participant: 'pa', shares: '15' }],
        splitMode: 'BY_AMOUNT',
        isReimbursement: true,
      },
    })
    const usd = ((await checked('get_balances', { groupId: 'g1', currencyCode: 'USD' }))['currencies'] as Bucket[])[0]
    expect(usd).toEqual({ currencyCode: 'USD', balances: {}, reimbursements: [] })
  })

  it('reads balances as of an earlier recorded change', async () => {
    const log = (await checked('list_activity', { groupId: 'g1', expenseId: id21(21) }))['activities'] as { id: string }[]
    const before = (await checked('list_activity', { groupId: 'g1', limit: 1, atActivityId: log[0]?.id ?? '', order: 'desc', cursor: 1 }))['activities'] as { id: string }[]
    const past = await checked('get_balances', { groupId: 'g1', currencyCode: 'USD', atActivityId: before[0]?.id ?? '' })
    expect(past['history']).toMatchObject({ atActivityId: before[0]?.id, complete: true, unavailableExpenseIds: [] })
    expect(((past['currencies'] as Bucket[])[0]?.reimbursements ?? []).length).toBe(2)
    const precise = await failure(h, { name: 'get_balances', args: { groupId: 'g1', asOf: '2026-11-01T00:00:00.0001Z' }, headers: alice })
    expect(precise.code).toBe('VALIDATION')
    const future = await failure(h, { name: 'get_balances', args: { groupId: 'g1', asOf: '2999-01-01T00:00:00Z' }, headers: alice })
    expect(future).toMatchObject({ code: 'BAD_REQUEST', message: 'asOf cannot be in the future' })
  })

  it('sums account balances per currency, restricts the scope, and refuses a foreign group or participant', async () => {
    const all = await checked('get_participant_balances', {})
    // The private expense is repaid, so only the named group counts.
    expect(all['totals']).toEqual([
      { currencyCode: 'JPY', amount: '-1500' },
      { currencyCode: 'USD', amount: '0.00' },
    ])
    expect((all['balances'] as { groupId: string; currency: string }[]).find((b) => b.groupId === id21(10))).toMatchObject({ currency: '$', amount: '0.00' })
    const bobView = await checked('get_participant_balances', { groups: [{ groupId: 'g1', participantId: 'pb' }] })
    expect(bobView['totals']).toEqual([
      { currencyCode: 'JPY', amount: '1500' },
      { currencyCode: 'USD', amount: '0.00' },
    ])
    const denied = await failure(h, { name: 'get_participant_balances', args: { groups: [{ groupId: 'g1' }, { groupId: 'g2' }] }, headers: alice })
    expect(denied.code).toBe('FORBIDDEN')
    const foreign = await failure(h, { name: 'get_participant_balances', args: { groups: [{ groupId: 'g1', participantId: 'qb' }] }, headers: alice })
    expect(foreign).toMatchObject({ code: 'BAD_REQUEST', message: 'Participant does not belong to this group.' })
    const twice = await failure(h, { name: 'get_participant_balances', args: { groups: [{ groupId: 'g1' }, { groupId: 'g1' }] }, headers: alice })
    expect(twice.message).toContain('Choose each group or private context only once.')
  })
})

describe('history', () => {
  it('shows agent writes with their actor, and the key ID only to its owner', async () => {
    await checked('update_expense', { groupId: 'g1', expenseId: id21(1), expectedRevision: 1, changes: { amount: '36' } })
    const mine = (await checked('list_activity', { groupId: 'g1', expenseId: id21(1), order: 'asc' }))['activities'] as Record<string, unknown>[]
    expect(mine.map((a) => a['activityType'])).toEqual(['CREATE_EXPENSE', 'UPDATE_EXPENSE'])
    expect(mine[1]).toMatchObject({ source: 'agent', actorUserId: 'alice', agentKeyId: aliceKeyId, expenseRevision: 2, expense: { id: id21(1), amount: '36.00', revision: 2 } })
    expect(mine[1]?.['snapshot']).toMatchObject({ kind: 'expense', group: { id: 'g1' }, expense: { amount: '36.00', paidBy: { id: 'pa' } } })
    expect(mine[1]?.['previousSnapshot']).toMatchObject({ expense: { amount: '30.00' } })
    const seenByBob = (await checked('list_activity', { groupId: 'g1', expenseId: id21(1), order: 'asc' }, bob))['activities'] as Record<string, unknown>[]
    expect(seenByBob[1]).toMatchObject({ actorUserId: 'alice', agentKeyId: null })
  })

  it('keeps pages fixed at the returned boundary and leaves out live state there', async () => {
    const first = await checked('list_activity', { groupId: 'g1', limit: 2 })
    const boundary = first['atActivityId'] as string
    await create({ id: 30, expense: { title: 'Late', amount: '1', paidBy: 'pa', paidFor: [{ participant: 'pa', shares: '1' }] } })
    const again = await checked('list_activity', { groupId: 'g1', limit: 2, atActivityId: boundary })
    expect(again['activities']).toEqual((first['activities'] as Record<string, unknown>[]).map(({ expense: _live, ...rest }) => rest))
    const foreign = await failure(h, { name: 'list_activity', args: { groupId: 'g1', atActivityId: 'no-such-event' }, headers: alice })
    expect(foreign).toMatchObject({ code: 'NOT_FOUND', message: 'History boundary not found in this group' })
  })

  it('reads a saved revision and a historical list without live values', async () => {
    const old = await checked('get_expense', { groupId: 'g1', expenseId: id21(1), revision: 1 })
    expect(old['expense']).toMatchObject({ amount: '30.00', revision: 1, deletedAt: null, recurringExpenseLink: null, attribution: { createdBy: { userId: 'alice' }, updatedBy: null } })
    expect(old['history']).toMatchObject({ revision: 1, deleted: false, snapshot: { kind: 'expense', expense: { amount: '30.00' } } })
    const log = (await checked('list_activity', { groupId: 'g1', expenseId: id21(1), order: 'asc' }))['activities'] as { id: string }[]
    const list = await checked('list_expenses', { groupId: 'g1', atActivityId: log[0]?.id ?? '', limit: 100 })
    expect(list['history']).toMatchObject({ atActivityId: log[0]?.id, complete: true })
    expect((list['expenses'] as { id: string; amount: string }[]).find((e) => e.id === id21(1))?.amount).toBe('30.00')
  })
})

describe('stats, export, reference data and recurrence', () => {
  it('reports stats in one currency, for a chosen participant', async () => {
    const stats = await checked('get_spending_stats', { groupId: 'g1', currencyCode: 'USD', participantId: 'pb', from: '2026-11-01', to: '2026-11-30' })
    // Spending is 36 + 12 + 1; the repayment is not spending.
    expect(stats).toMatchObject({ currencyCode: 'USD', availableCurrencyCodes: ['JPY', 'USD'], totalGroupSpendings: '49.00', totalParticipantSpendings: '12.00', totalParticipantShare: '24.00' })
    expect(stats['summary']).toMatchObject({ expenseCount: 3, totalSpending: '49.00' })
    const plain = await checked('get_spending_stats', { groupId: 'g1' })
    expect(plain).not.toHaveProperty('totalParticipantSpendings')
  })

  it('exports the group as the export RPC does', async () => {
    const json = await checked('export_group', { groupId: 'g1' })
    expect(json).toMatchObject({ filename: 'agentsplit-g1.json', contentType: 'application/json' })
    expect(JSON.parse(json['content'] as string)).toMatchObject({ id: 'g1', name: 'Home sweet home' })
    const csv = await checked('export_group', { groupId: 'g1', format: 'csv' })
    expect(csv).toMatchObject({ filename: 'agentsplit-g1.csv', contentType: 'text/csv' })
    expect((await failure(h, { name: 'export_group', args: { groupId: 'g2' }, headers: alice })).code).toBe('FORBIDDEN')
  })

  it('lists reference data in the current names', async () => {
    const reference = await checked('get_reference_data', {})
    expect(reference['splitModes']).toEqual(['EVENLY', 'BY_SHARES', 'BY_PERCENTAGE', 'BY_AMOUNT'])
    expect(reference['recurrenceRules']).toEqual(['NONE', 'DAILY', 'WEEKLY', 'MONTHLY'])
    expect((reference['currencies'] as { code: string; decimalPlaces: number }[]).find((c) => c.code === 'JPY')?.decimalPlaces).toBe(0)
    expect(reference['currencies']).toHaveLength(34)
  })

  it('creates due occurrences only in the given group, once', async () => {
    const start = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)
    await create({ id: 40, expense: { title: 'Coffee', expenseDate: start, amount: '3', paidBy: 'pa', paidFor: [{ participant: 'pa', shares: '1' }], recurrenceRule: 'DAILY' } })
    const before = await checked('list_expenses', { groupId: 'g1', filter: 'Coffee' })
    expect((before['expenses'] as unknown[]).length).toBe(1)
    const denied = await failure(h, { name: 'process_recurring_expenses', args: { groupId: 'g2' }, headers: alice })
    expect(denied.code).toBe('FORBIDDEN')
    const processed = await checked('process_recurring_expenses', { groupId: 'g1' })
    expect((processed['createdExpenseIds'] as string[]).length).toBe(2)
    expect(await checked('process_recurring_expenses', { groupId: 'g1' })).toEqual({ createdExpenseIds: [] })
  })
})
