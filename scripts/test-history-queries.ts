import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { POST } from '../src/app/api/mcp/route'
import {
  createExpense,
  createGroup,
  deleteExpense,
  updateExpense,
  updateGroup,
} from '../src/lib/api'
import { MCP_OUTPUT_SCHEMAS } from '../src/lib/mcp/output-schemas'
import { prisma } from '../src/lib/prisma'
import { randomId } from '../src/lib/random'
import { appRouter } from '../src/trpc/routers/_app'
import { seedTestAgent } from './auth-test-utils'

const url = new URL(process.env.POSTGRES_PRISMA_URL ?? '')
assert(
  ['localhost', '127.0.0.1'].includes(url.hostname) &&
    url.pathname.endsWith('_audit_test'),
  'Disposable local audit database only',
)
const userId = `history-${randomId()}`,
  token = randomBytes(32).toString('base64url')
const keyId = await seedTestAgent(userId, token)
const principal = {
  userId,
  connectionId: keyId,
  groupIds: [] as string[],
  source: 'agent' as const,
}
const caller = appRouter.createCaller({ principal, readOnly: true })
const group = await createGroup(
  {
    name: 'History query verification',
    currency: '$',
    currencyCode: 'USD',
    participants: [{ name: 'Alice' }, { name: 'Bob' }],
  },
  principal,
)
const groupId = group.id
principal.groupIds.push(groupId)
const alice = group.participants.find((p) => p.name === 'Alice')!,
  bob = group.participants.find((p) => p.name === 'Bob')!
const expenseForm = {
  title: 'Original dinner',
  amount: '60',
  currencyCode: 'USD' as const,
  category: 0,
  expenseDate: new Date('2020-01-01'),
  paidBy: alice.id,
  paidFor: [alice, bob].map((p) => ({ participant: p.id, shares: '1' })),
  splitMode: 'EVENLY' as const,
  isReimbursement: false,
  documents: [],
  notes: 'original',
  recurrenceRule: 'NONE' as const,
  saveDefaultSplittingOptions: false,
}
let passed = 0
async function check(name: string, run: () => Promise<void>) {
  await run()
  console.log(`PASS ${name}`)
  passed++
}
const creation = await prisma.activity.findFirstOrThrow({
  where: { groupId },
  orderBy: { sequence: 'desc' },
})
const expense = await createExpense(
  expenseForm,
  groupId,
  undefined,
  randomId(),
  principal,
)
const initial = await prisma.activity.findFirstOrThrow({
  where: { groupId, expenseId: expense.id },
  orderBy: { sequence: 'desc' },
})
await new Promise((resolve) => setTimeout(resolve, 5))
await updateExpense(
  groupId,
  expense.id,
  { amount: '90', notes: 'edited' },
  undefined,
  principal,
  1,
)
const edited = await prisma.activity.findFirstOrThrow({
  where: { groupId, expenseId: expense.id },
  orderBy: { sequence: 'desc' },
})
await new Promise((resolve) => setTimeout(resolve, 5))
await updateGroup(
  groupId,
  {
    participants: [
      ...group.participants.filter((p) => p.id !== alice.id && p.id !== bob.id),
      { id: alice.id, name: 'Renamed Alice' },
      { id: bob.id, name: 'Renamed Bob' },
    ],
  },
  undefined,
  principal,
  1,
)
await deleteExpense(groupId, expense.id, undefined, principal, 2)
const deletion = await prisma.activity.findFirstOrThrow({
  where: { groupId, expenseId: expense.id },
  orderBy: { sequence: 'desc' },
})
await check(
  'specific revision preserves the original values and names',
  async () => {
    const result = await caller.groups.expenses.get({
      groupId,
      expenseId: expense.id,
      revision: 1,
    })
    assert.equal(result.expense.amount, '60')
    assert.equal(result.expense.paidBy.name, 'Alice')
    assert.equal(
      result.history?.snapshot.expense.paidFor.find(
        (p) => p.participantId === bob.id,
      )?.name,
      'Bob',
    )
    assert.equal(result.history?.deleted, false)
    assert.equal(result.expense.revision, 1)
  },
)
await check(
  'timestamp returns earlier revision after later edit and deletion',
  async () => {
    const result = await caller.groups.expenses.get({
      groupId,
      expenseId: expense.id,
      asOf: initial.time.toISOString(),
    })
    assert.equal(result.expense.amount, '60')
    assert.equal(result.history?.activityId, initial.id)
  },
)
await check(
  'deletion revision includes retained state and a deletion marker',
  async () => {
    const result = await caller.groups.expenses.get({
      groupId,
      expenseId: expense.id,
      revision: 3,
    })
    assert.equal(result.expense.amount, '90')
    assert.equal(result.expense.revision, 3)
    assert(result.expense.deletedAt)
    assert.equal(result.history?.deleted, true)
    assert.equal(result.history?.snapshot.expense.revision, 2)
  },
)
await check('ordinary current read still hides deleted expenses', async () => {
  await assert.rejects(
    () => caller.groups.expenses.get({ groupId, expenseId: expense.id }),
    /not found/,
  )
})
await check(
  'pre-creation history does not infer presence from the expense date',
  async () => {
    const page = await caller.groups.expenses.list({
      groupId,
      atActivityId: creation.id,
    })
    assert.equal(page.expenses.length, 0)
    assert.equal(page.history?.complete, true)
  },
)
await check(
  'historical ledger reappears before deletion and disappears at deletion',
  async () => {
    const before = await caller.groups.expenses.list({
      groupId,
      atActivityId: edited.id,
    })
    assert.equal(before.expenses.length, 1)
    assert.equal(before.expenses[0].amount, '90')
    const after = await caller.groups.expenses.list({
      groupId,
      atActivityId: deletion.id,
    })
    assert.equal(after.expenses.length, 0)
  },
)
await check(
  'historical balances use original splits with exact decimals',
  async () => {
    const result = await caller.groups.balances.list({
      groupId,
      atActivityId: initial.id,
    })
    assert.equal(result.currencies[0].balances[alice.id].total, '30')
    assert.equal(result.currencies[0].balances[bob.id].total, '-30')
    const editedBalance = await caller.groups.balances.list({
      groupId,
      atActivityId: edited.id,
    })
    assert.equal(editedBalance.currencies[0].balances[bob.id].total, '-45')
  },
)
await check(
  'historical filters apply to saved values before pagination',
  async () => {
    const result = await caller.groups.expenses.list({
      groupId,
      atActivityId: initial.id,
      filter: 'original',
      currencyCode: 'USD',
      from: '2020-01-01',
      to: '2020-01-01',
      participantId: bob.id,
      limit: 1,
    })
    assert.equal(result.expenses.length, 1)
    assert.equal(
      (
        await caller.groups.expenses.list({
          groupId,
          atActivityId: initial.id,
          currencyCode: 'JPY',
        })
      ).expenses.length,
      0,
    )
  },
)
const baseline = await caller.groups.activities.list({
  groupId,
  order: 'desc',
  limit: 1,
})
const full = await caller.groups.activities.list({
  groupId,
  order: 'desc',
  limit: 100,
  atActivityId: baseline.atActivityId!,
})
const later = await createExpense(
  {
    ...expenseForm,
    title: 'Later backdated entry',
    amount: '100',
    currencyCode: 'JPY',
  },
  groupId,
  undefined,
  randomId(),
  principal,
)
await check('history pages stay fixed while new events are added', async () => {
  const next = await caller.groups.activities.list({
    groupId,
    order: 'desc',
    limit: 1,
    cursor: baseline.nextCursor,
    atActivityId: baseline.atActivityId!,
  })
  assert.equal(next.activities[0].id, full.activities[1].id)
  const frozen = await caller.groups.activities.list({
    groupId,
    atActivityId: baseline.atActivityId!,
    limit: 100,
  })
  assert(!frozen.activities.some((a) => a.expenseId === later.id))
})
await check(
  'date-filtered history supports precise timestamps and chronological order',
  async () => {
    const result = await caller.groups.activities.list({
      groupId,
      expenseId: expense.id,
      recordedFrom: edited.time.toISOString(),
      recordedTo: deletion.time.toISOString(),
      order: 'asc',
    })
    assert.deepEqual(
      result.activities.map((a) => a.expenseRevision),
      [2, 3],
    )
    assert.equal(
      (
        await caller.groups.activities.list({
          groupId,
          expenseId: expense.id,
          asOf: initial.time.toISOString(),
        })
      ).activities.length,
      1,
    )
  },
)
await check(
  'historical activity does not attach current expense state',
  async () => {
    const result = await caller.groups.activities.list({
      groupId,
      asOf: initial.time.toISOString(),
    })
    assert(result.activities.every((a) => a.expense === undefined))
    assert(!JSON.stringify(result).includes('Later backdated entry'))
  },
)
await check(
  'historical read after backdating still excludes later-created rows',
  async () => {
    const result = await caller.groups.expenses.list({
      groupId,
      asOf: initial.time.toISOString(),
    })
    assert.deepEqual(
      result.expenses.map((e) => e.id),
      [expense.id],
    )
  },
)
await check('invalid selections and timestamps fail cleanly', async () => {
  await assert.rejects(() =>
    caller.groups.expenses.get({
      groupId,
      expenseId: expense.id,
      revision: 1,
      asOf: initial.time.toISOString(),
    }),
  )
  await assert.rejects(() =>
    caller.groups.expenses.list({ groupId, asOf: '2026-10-01' }),
  )
  await assert.rejects(
    () =>
      caller.groups.balances.list({ groupId, asOf: '2999-01-01T00:00:00Z' }),
    /future/,
  )
  await assert.rejects(() =>
    caller.groups.activities.list({
      groupId,
      recordedFrom: deletion.time.toISOString(),
      recordedTo: initial.time.toISOString(),
    }),
  )
})
await check('timestamp precision beyond milliseconds is rejected', async () => {
  await assert.rejects(() =>
    caller.groups.expenses.list({
      groupId,
      asOf: '2026-10-01T00:00:00.123456Z',
    }),
  )
})
await check(
  'missing historical revision and before-group views are explicit',
  async () => {
    await assert.rejects(
      () =>
        caller.groups.expenses.get({
          groupId,
          expenseId: expense.id,
          revision: 55,
        }),
      /No saved/,
    )
    await assert.rejects(
      () =>
        caller.groups.expenses.list({ groupId, asOf: '2000-01-01T00:00:00Z' }),
      /did not exist/,
    )
  },
)
const other = await createGroup({
  name: 'Other historical group',
  currency: '$',
  currencyCode: 'USD',
  participants: [{ name: 'Other' }],
})
const otherEvent = await prisma.activity.findFirstOrThrow({
  where: { groupId: other.id },
})
await check(
  'foreign groups and foreign history boundaries remain inaccessible',
  async () => {
    await assert.rejects(
      () =>
        caller.groups.expenses.list({
          groupId: other.id,
          asOf: initial.time.toISOString(),
        }),
      /access denied/,
    )
    await assert.rejects(
      () =>
        caller.groups.expenses.list({ groupId, atActivityId: otherEvent.id }),
      /not found/,
    )
    await assert.rejects(
      () =>
        caller.groups.expenses.get({
          groupId: other.id,
          expenseId: expense.id,
          revision: 1,
        }),
      /access denied/,
    )
  },
)
const legacyId = randomId()
await prisma.expense.create({
  data: {
    id: legacyId,
    groupId,
    title: 'Legacy unknown history',
    amount: '12',
    currencyCode: 'USD',
    categoryId: 0,
    paidById: alice.id,
    createdAt: new Date('2001-01-01'),
    expenseDate: new Date('2001-01-01'),
    paidFor: {
      create: group.participants.map((p) => ({
        participantId: p.id,
        shares: '1',
      })),
    },
    revision: 0,
  },
})
await check(
  'legacy gaps are disclosed and block misleading balance totals',
  async () => {
    const result = await caller.groups.expenses.list({
      groupId,
      atActivityId: initial.id,
    })
    assert.equal(result.history?.complete, false)
    assert.deepEqual(result.history?.unavailableExpenseIds, [legacyId])
    await assert.rejects(
      () => caller.groups.balances.list({ groupId, atActivityId: initial.id }),
      /Historical balances are unavailable/,
    )
  },
)
await updateExpense(
  groupId,
  legacyId,
  { notes: 'First audited edit' },
  undefined,
  principal,
  0,
)
const legacyRevision = await caller.groups.expenses.get({
  groupId,
  expenseId: legacyId,
  revision: 0,
})
await check(
  'baseline revision is available only from its actual recording point',
  async () => {
    assert.equal(legacyRevision.expense.amount, '12')
    const before = await caller.groups.expenses.list({
      groupId,
      atActivityId: initial.id,
    })
    assert.equal(before.history?.complete, false)
    const now = await caller.groups.expenses.list({
      groupId,
      asOf: new Date().toISOString(),
    })
    assert.equal(now.history?.complete, true)
  },
)
await check(
  'historical currencies remain separate after denomination edits',
  async () => {
    const head = await prisma.activity.findFirstOrThrow({
      where: { groupId },
      orderBy: { sequence: 'desc' },
    })
    const before = await caller.groups.balances.list({
      groupId,
      atActivityId: head.id,
    })
    assert.deepEqual(
      before.currencies.map((c) => c.currencyCode),
      ['JPY', 'USD'],
    )
    await updateExpense(
      groupId,
      later.id,
      { currencyCode: 'USD' },
      undefined,
      principal,
      1,
    )
    const frozen = await caller.groups.balances.list({
      groupId,
      atActivityId: head.id,
    })
    assert.deepEqual(frozen, before)
    const after = await caller.groups.balances.list({
      groupId,
      asOf: new Date().toISOString(),
    })
    assert.deepEqual(
      after.currencies.map((c) => c.currencyCode),
      ['USD'],
    )
  },
)
await check(
  'expense pagination reuses the saved boundary after edits change live ordering',
  async () => {
    const head = await prisma.activity.findFirstOrThrow({
      where: { groupId },
      orderBy: { sequence: 'desc' },
    })
    const all = await caller.groups.expenses.list({
      groupId,
      atActivityId: head.id,
      limit: 100,
    })
    const first = await caller.groups.expenses.list({
      groupId,
      atActivityId: head.id,
      limit: 1,
    })
    await updateExpense(
      groupId,
      later.id,
      { expenseDate: new Date('2000-01-01') },
      undefined,
      principal,
      2,
    )
    const second = await caller.groups.expenses.list({
      groupId,
      atActivityId: head.id,
      limit: 1,
      cursor: first.nextCursor,
    })
    assert.deepEqual(
      [first.expenses[0].id, second.expenses[0].id],
      all.expenses.map((e) => e.id),
    )
  },
)
async function mcpCall(name: string, args: Record<string, unknown>) {
  const r = await POST(
    new Request(`${process.env.BASE_URL}/api/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json,text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
  )
  assert.equal(r.status, 200)
  const raw = await r.text()
  const body = JSON.parse(
    raw
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice(6) ?? raw,
  ) as { result: { isError?: boolean; structuredContent: unknown } }
  assert(!body.result.isError, JSON.stringify(body))
  return body.result.structuredContent
}
await check(
  'real MCP historical responses satisfy declared structured schemas',
  async () => {
    const expenseResult = await mcpCall('get_expense', {
      groupId,
      expenseId: expense.id,
      revision: 1,
    })
    assert.equal(
      MCP_OUTPUT_SCHEMAS['groups.expenses.get'].parse(expenseResult).expense
        .amount,
      '60',
    )
    const list = await mcpCall('list_expenses', {
      groupId,
      atActivityId: initial.id,
    })
    assert.equal(
      MCP_OUTPUT_SCHEMAS['groups.expenses.list'].parse(list).history?.complete,
      false,
    )
    const history = await mcpCall('list_activity', {
      groupId,
      order: 'asc',
      limit: 2,
    })
    assert.equal(
      MCP_OUTPUT_SCHEMAS['groups.activities.list'].parse(history).activities
        .length,
      2,
    )
    const balances = await mcpCall('get_balances', {
      groupId,
      asOf: new Date().toISOString(),
    })
    assert(
      MCP_OUTPUT_SCHEMAS['groups.balances.list'].parse(balances).history
        ?.complete,
    )
  },
)
await check(
  'historical reads create no events, rows, or revisions',
  async () => {
    const count = await prisma.activity.count({ where: { groupId } })
    const expenses = await prisma.expense.findMany({
      where: { groupId },
      select: { id: true, revision: true },
    })
    await caller.groups.expenses.get({
      groupId,
      expenseId: expense.id,
      revision: 2,
    })
    await caller.groups.expenses.list({
      groupId,
      asOf: new Date().toISOString(),
    })
    await caller.groups.balances.list({
      groupId,
      asOf: new Date().toISOString(),
    })
    assert.equal(await prisma.activity.count({ where: { groupId } }), count)
    assert.deepEqual(
      await prisma.expense.findMany({
        where: { groupId },
        select: { id: true, revision: true },
      }),
      expenses,
    )
  },
)
await check('revoked membership also blocks historical reads', async () => {
  await prisma.userGroupAccess.update({
    where: { userId_groupId: { userId, groupId } },
    data: { active: false },
  })
  await assert.rejects(
    () =>
      caller.groups.expenses.get({
        groupId,
        expenseId: expense.id,
        revision: 1,
      }),
    /access denied/,
  )
})
console.log(`${passed} history-query PostgreSQL scenarios passed`)
await prisma.$disconnect()
