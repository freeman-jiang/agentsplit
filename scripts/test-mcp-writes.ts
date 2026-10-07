import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/core'
import { z } from 'zod'
import { expenseSnapshotSchema } from '../src/lib/expense-history'
import { hashAccessKey } from '../src/lib/mcp/access'
import { prisma } from '../src/lib/prisma'
import { randomId } from '../src/lib/random'
import { seedTestAgent } from './auth-test-utils'

const database = new URL(process.env.POSTGRES_PRISMA_URL ?? '')
assert(
  ['localhost', '127.0.0.1'].includes(database.hostname) &&
    database.pathname.endsWith('_audit_test'),
  'Use a disposable loopback database ending in _audit_test',
)
const owner = `mcp-owner-${randomId()}`,
  outsider = `mcp-other-${randomId()}`
const token = randomBytes(32).toString('base64url'),
  secondToken = randomBytes(32).toString('base64url'),
  otherToken = randomBytes(32).toString('base64url')
const oldConfig = process.env.MCP_ACCESS_GRANTS,
  oldBase = process.env.BASE_URL
process.env.BASE_URL = 'http://localhost:3001'
process.env.MCP_ACCESS_GRANTS = JSON.stringify({
  users: [
    { id: owner, groupIds: [] },
    { id: outsider, groupIds: [] },
  ],
  keys: [
    { id: 'primary', userId: owner, tokenSha256: hashAccessKey(token) },
    { id: 'second', userId: owner, tokenSha256: hashAccessKey(secondToken) },
    { id: 'other', userId: outsider, tokenSha256: hashAccessKey(otherToken) },
  ],
})
const passed: string[] = []
async function main() {
  const primaryKeyId = await seedTestAgent(owner, token)
  await seedTestAgent(owner, secondToken)
  await seedTestAgent(outsider, otherToken)
  const { POST } = await import('../src/app/api/mcp/route')
  async function rpc(
    method: string,
    params: Record<string, unknown>,
    key = token,
  ) {
    const response = await POST(
      new Request('http://localhost:3001/api/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    )
    assert.equal(response.status, 200)
    const text = await response.text()
    const body = z
      .object({ error: z.unknown().optional(), result: z.unknown() })
      .parse(
        JSON.parse(
          text
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice(6) ?? text,
        ),
      )
    assert(!body.error, JSON.stringify(body.error))
    return body.result
  }
  async function call(
    name: string,
    args: Record<string, unknown>,
    key = token,
  ): Promise<any> {
    const result = CallToolResultSchema.parse(
      await rpc('tools/call', { name, arguments: args }, key),
    )
    assert.notEqual(
      result.isError,
      true,
      `${name}: ${JSON.stringify(result.content)}`,
    )
    return result.structuredContent
  }
  async function rejects(
    name: string,
    args: Record<string, unknown>,
    key = token,
  ) {
    const result = CallToolResultSchema.parse(
      await rpc('tools/call', { name, arguments: args }, key),
    )
    assert.equal(result.isError, true, `${name} should be rejected`)
  }
  const check = (name: string) => {
    passed.push(name)
    console.log(`PASS ${name}`)
  }
  try {
    const catalog = ListToolsResultSchema.parse(await rpc('tools/list', {}))
    assert.equal(catalog.tools.length, 17)
    assert.equal(
      catalog.tools.find((t) => t.name === 'create_expense')?.annotations
        ?.readOnlyHint,
      false,
    )
    const updateSchema = catalog.tools.find(
      (t) => t.name === 'update_expense',
    )?.inputSchema
    assert(updateSchema?.required?.includes('expectedRevision'))
    check(
      'discovery exposes the reviewed write surface and required revision hints',
    )
    const created = await call('create_group', {
      group: {
        name: 'MCP write integration',
        currency: '$',
        currencyCode: 'USD',
        participants: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }],
      },
    })
    const groupId = created.groupId
    const participants = created.group.participants as {
      id: string
      name: string
    }[]
    const alice = participants.find((p) => p.name === 'Alice')!,
      bob = participants.find((p) => p.name === 'Bob')!
    for (const key of [token, secondToken])
      assert(
        (await call('list_groups', {}, key)).groups.some(
          (g: any) => g.id === groupId,
        ),
      )
    assert(
      !(await call('list_groups', {}, otherToken)).groups.some(
        (g: any) => g.id === groupId,
      ),
    )
    await rejects('get_group', { groupId }, otherToken)
    check(
      'group creation persists membership for all owner keys and excludes another user',
    )
    const details = await call('get_group', { groupId })
    const invitation = await call('manage_group_access', {
      action: 'invite',
      groupId,
      email: `${outsider}@example.com`,
      participantId: bob.id,
    })
    await call(
      'manage_group_access',
      { action: 'join', shareUrl: invitation.invitation.url },
      otherToken,
    )
    assert(
      (await call('list_groups', {}, otherToken)).groups.some(
        (g: any) => g.id === groupId,
      ),
    )
    await call('manage_group_access', { action: 'leave', groupId }, otherToken)
    await rejects('get_group', { groupId }, otherToken)
    await rejects(
      'manage_group_access',
      { action: 'join', shareUrl: `https://evil.example/groups/${groupId}` },
      otherToken,
    )
    check(
      'email-bound invitation URLs grant membership; leaving and foreign-origin rejection enforce scope',
    )
    const form = {
      title: 'MCP dinner',
      expenseDate: '2026-10-01',
      amount: '10',
      currencyCode: 'USD',
      category: 0,
      paidBy: bob.id,
      paidFor: participants
        .filter((p) => ['Alice', 'Bob', 'Carol'].includes(p.name))
        .map((p) => ({ participant: p.id, shares: '1' })),
      splitMode: 'EVENLY',
      isReimbursement: false,
      notes: 'Keep these notes',
      documents: [],
      recurrenceRule: 'NONE',
    }
    const expenseId = randomId()
    const expense = await call('create_expense', {
      groupId,
      expenseId,
      expense: form,
    })
    assert.equal(expense.amount, '10')
    assert.equal(expense.revision, 1)
    assert.deepEqual(expense.uploads, [])
    const events = await call('list_activity', { groupId, expenseId })
    assert.equal(events.activities[0].actorUserId, owner)
    assert.equal(events.activities[0].actorName, owner)
    assert.equal(events.activities[0].agentKeyId, primaryKeyId)
    assert.equal(events.activities[0].participantId, null)
    await rejects('create_expense', { groupId, expenseId, expense: form })
    check(
      'expense writes return canonical strings and audit the authenticated actor without impersonation or duplicate IDs',
    )
    const edited = await call('update_expense', {
      groupId,
      expenseId,
      expectedRevision: 1,
      changes: { title: 'Edited dinner' },
    })
    assert.equal(edited.revision, 2)
    const saved = (await call('get_expense', { groupId, expenseId })).expense
    assert.equal(saved.amount, '10')
    assert.equal(saved.notes, 'Keep these notes')
    assert.equal(saved.paidFor.length, 3)
    await rejects('update_expense', {
      groupId,
      expenseId,
      expectedRevision: 1,
      changes: { amount: '99' },
    })
    await rejects('update_expense', {
      groupId,
      expenseId,
      changes: { amount: '99' },
    })
    await rejects('delete_expense', { groupId, expenseId, expectedRevision: 1 })
    const noOp = await call('update_expense', {
      groupId,
      expenseId,
      expectedRevision: 2,
    })
    assert.equal(noOp.revision, 2)
    check(
      'partial edits preserve omitted fields, no-op edits avoid revisions, and stale/missing revisions fail',
    )
    await rejects('create_expense', {
      groupId,
      expense: { ...form, amount: 10 },
    })
    await rejects('create_expense', {
      groupId,
      expense: { ...form, currencyCode: 'JPY', amount: '10.1' },
    })
    await rejects('create_expense', {
      groupId,
      expense: { ...form, expenseDate: 'not-a-date' },
    })
    await rejects('update_expense', {
      groupId,
      expenseId,
      expectedRevision: 2,
      attachUploadIds: [randomId()],
    })
    assert.equal(
      (await call('get_expense', { groupId, expenseId })).expense.revision,
      2,
    )
    check(
      'strict money/date parsing and unfinished-upload rejection cannot partially change an expense',
    )
    const balances = (await call('get_balances', { groupId })).currencies[0]
    assert.equal(balances.balances[bob.id].total, '6.66')
    for (const payment of balances.reimbursements)
      await call('create_expense', {
        groupId,
        expense: {
          ...form,
          title: 'Recorded payment',
          paidBy: payment.from,
          paidFor: [{ participant: payment.to, shares: '1' }],
          amount: payment.amount,
          isReimbursement: true,
        },
      })
    assert.deepEqual(
      (await call('get_balances', { groupId })).currencies[0].reimbursements,
      [],
    )
    const filtered = await call('list_expenses', {
      groupId,
      isReimbursement: false,
      paidById: bob.id,
      categoryId: 0,
      participantId: alice.id,
      limit: 1,
    })
    assert.equal(filtered.expenses.length, 1)
    assert.equal(filtered.expenses[0].id, expenseId)
    assert.equal(filtered.hasMore, false)
    check('payments settle balances and broad filters apply before pagination')
    const groupEdit = await call('update_group', {
      groupId,
      expectedRevision: details.group.revision,
      changes: { name: 'Updated MCP group' },
    })
    assert.equal(groupEdit.group.participants.length, 4)
    await rejects('update_group', {
      groupId,
      expectedRevision: details.group.revision,
      group: { name: 'Stale overwrite' },
    })
    const reference = await call('get_reference_data', {})
    assert(
      reference.currencies.some(
        (c: any) => c.code === 'JPY' && c.decimalPlaces === 0,
      ),
    )
    const exported = await call('export_group', { groupId, format: 'json' })
    assert.equal(
      z.object({ id: z.string() }).parse(JSON.parse(exported.content)).id,
      groupId,
    )
    check(
      'group patches, metadata discovery and authenticated exports use the shared backend',
    )
    await call('delete_expense', { groupId, expenseId, expectedRevision: 2 })
    await rejects('get_expense', { groupId, expenseId })
    const history = await call('list_activity', { groupId, expenseId })
    assert.deepEqual(
      history.activities.map((a: any) => a.expenseRevision),
      [3, 2, 1],
    )
    assert.equal(
      expenseSnapshotSchema.parse(history.activities[0].previousSnapshot)
        .expense.title,
      'Edited dinner',
    )
    check('soft deletion preserves complete immutable revisions')
    const foreign = await call(
      'create_group',
      {
        group: {
          name: 'Other MCP group',
          currency: '$',
          currencyCode: 'USD',
          participants: [{ name: 'Someone' }],
        },
      },
      otherToken,
    )
    await rejects('create_expense', { groupId: foreign.groupId, expense: form })
    await rejects('update_group', {
      groupId,
      expectedRevision: groupEdit.group.revision,
      changes: { participants: foreign.group.participants },
    })
    assert.equal(
      (await call('get_group', { groupId })).group.participants.length,
      4,
    )
    await rejects('process_recurring_expenses', { groupId: foreign.groupId })
    await rejects('export_group', { groupId: foreign.groupId })
    check('mutation, recurrence and export requests cannot cross memberships')
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10)
    await call('create_expense', {
      groupId,
      expense: {
        ...form,
        title: 'Recurring MCP expense',
        expenseDate: yesterday,
        recurrenceRule: 'DAILY',
      },
    })
    const otherPerson = foreign.group.participants[0]
    await call(
      'create_expense',
      {
        groupId: foreign.groupId,
        expense: {
          ...form,
          title: 'Foreign recurring expense',
          expenseDate: yesterday,
          recurrenceRule: 'DAILY',
          paidBy: otherPerson.id,
          paidFor: [{ participant: otherPerson.id, shares: '1' }],
        },
      },
      otherToken,
    )
    const beforeOwn = await prisma.expense.count({ where: { groupId } })
    const beforeForeign = await prisma.expense.count({
      where: { groupId: foreign.groupId },
    })
    await call('list_expenses', { groupId })
    assert.equal(await prisma.expense.count({ where: { groupId } }), beforeOwn)
    const processed = await call('process_recurring_expenses', { groupId })
    assert(processed.createdExpenseIds.length >= 1)
    assert.equal(
      await prisma.expense.count({ where: { groupId: foreign.groupId } }),
      beforeForeign,
    )
    assert.deepEqual(
      (await call('process_recurring_expenses', { groupId })).createdExpenseIds,
      [],
    )
    check(
      'explicit recurrence processing materializes only the authorized group and does not duplicate frames',
    )
    console.log(`Passed ${passed.length} full-MCP PostgreSQL scenarios`)
  } finally {
    if (oldConfig === undefined) delete process.env.MCP_ACCESS_GRANTS
    else process.env.MCP_ACCESS_GRANTS = oldConfig
    if (oldBase === undefined) delete process.env.BASE_URL
    else process.env.BASE_URL = oldBase
    await prisma.$disconnect()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
