/** Exercises the actual running MCP endpoint; creates only isolated test accounts. */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import {
  CallToolResultSchema,
  InitializeResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/core'
import { z } from 'zod'
import { MCP_OUTPUT_SCHEMAS } from '../src/lib/mcp/output-schemas'
import { MCP_TOOL_REGISTRY } from '../src/lib/mcp/registry'
import { prisma } from '../src/lib/prisma'
import { randomId } from '../src/lib/random'

const endpoint = new URL(
  process.env.MCP_TEST_URL ?? 'http://127.0.0.1:3048/api/mcp',
)
const database = new URL(process.env.POSTGRES_PRISMA_URL ?? '')
assert(['127.0.0.1', 'localhost'].includes(endpoint.hostname))
assert(
  ['127.0.0.1', 'localhost'].includes(database.hostname) &&
    /test|e2e/.test(database.pathname),
)
type Json = z.infer<ReturnType<typeof z.json>>
type Actor = {
  id: string
  name: string
  email: string
  key: string
  keyId: string
}
type ToolName = (typeof MCP_TOOL_REGISTRY)[number]['name']
type ToolOutput<N extends ToolName> = z.output<
  (typeof MCP_OUTPUT_SCHEMAS)[Extract<
    (typeof MCP_TOOL_REGISTRY)[number],
    { name: N }
  >['procedure']]
>
const envelope = z.object({
  result: z.json().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
})
let sequence = 0
let checks = 0
const suffix = randomBytes(4).toString('hex')
async function account({
  name,
  verified = true,
}: {
  name: string
  verified?: boolean
}): Promise<Actor> {
  const id = `mcp-${suffix}-${name}`,
    email = `${id}@example.com`,
    key = randomBytes(32).toString('base64url')
  await prisma.user.create({
    data: { id, name, email, emailVerified: verified },
  })
  const record = await prisma.apikey.create({
    data: {
      id: randomId(),
      name: 'Local workflow verification',
      referenceId: id,
      key: createHash('sha256').update(key).digest('base64url'),
      rateLimitEnabled: false,
    },
  })
  return { id, name, email, key, keyId: record.id }
}
const alice = await account({ name: 'Alice' }),
  bob = await account({ name: 'Bob' }),
  guest = await account({ name: 'Guest' }),
  outsider = await account({ name: 'Outsider' }),
  unverified = await account({ name: 'Unverified', verified: false })
const actors = [alice, bob, guest, outsider, unverified]
async function rpc({
  actor = alice,
  method,
  params,
}: {
  actor?: Actor
  method: string
  params: Record<string, Json>
}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-api-key': actor.key,
      'mcp-protocol-version': '2025-03-26',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
  })
  assert.equal(response.status, 200, `${method}: HTTP ${response.status}`)
  const text = await response.text()
  const body = envelope.parse(
    JSON.parse(
      text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6) ?? text,
    ),
  )
  assert(!body.error, `${method}: ${body.error?.message}`)
  return body.result
}
async function call<N extends ToolName>({
  name,
  args = {},
  actor = alice,
}: {
  name: N
  args?: Record<string, Json>
  actor?: Actor
}): Promise<ToolOutput<N>> {
  const result = CallToolResultSchema.parse(
    await rpc({
      actor,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  )
  assert(!result.isError, `${name}: ${JSON.stringify(result.content)}`)
  const definition = MCP_TOOL_REGISTRY.find((tool) => tool.name === name)!
  return MCP_OUTPUT_SCHEMAS[definition.procedure].parse(
    result.structuredContent,
  ) as ToolOutput<N>
}
async function rejects({
  name,
  args,
  actor = alice,
}: {
  name: ToolName
  args: Record<string, Json>
  actor?: Actor
}) {
  const result = CallToolResultSchema.parse(
    await rpc({
      actor,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  )
  assert.equal(result.isError, true, `${name} must reject invalid input`)
}
function passed(message: string) {
  checks++
  console.log(`PASS ${message}`)
}

try {
  const initialized = InitializeResultSchema.parse(
    await rpc({
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'expense-workflow-test', version: '1' },
      },
    }),
  )
  assert(initialized.instructions?.includes('global'))
  const catalog = ListToolsResultSchema.parse(
    await rpc({ method: 'tools/list', params: {} }),
  )
  assert.equal(catalog.tools.length, 20)
  assert(
    !catalog.tools
      .find((tool) => tool.name === 'create_expense')
      ?.inputSchema.required?.includes('groupId'),
  )
  assert(catalog.tools.some((tool) => tool.name === 'update_profile'))
  passed('discovery documents global names and optional-group creation')

  const options = await call({ name: 'get_expense_options' })
  assert.equal(options.userId, alice.id)
  const made = await call({
    name: 'create_group',
    args: {
      group: {
        name: `MCP household ${suffix}`,
        currency: '$',
        currencyCode: 'USD',
        participants: [],
      },
    },
  })
  const added = await call({
    name: 'update_group',
    args: {
      groupId: made.groupId,
      expectedRevision: made.group.revision,
      changes: {
        participants: [
          ...made.group.participants.map((p) => ({ id: p.id, name: p.name })),
          { name: 'Bob placeholder' },
        ],
      },
    },
  })
  const bobPlaceholder = added.group.participants.find(
    (p) => p.name === 'Bob placeholder',
  )!
  const invitation = await call({
    name: 'manage_group_access',
    args: {
      action: 'invite',
      groupId: made.groupId,
      email: bob.email,
      participantId: bobPlaceholder.id,
    },
  })
  await call({
    name: 'manage_group_access',
    actor: bob,
    args: { action: 'join', shareUrl: invitation.invitation!.url },
  })
  const currentGroup = await call({
    name: 'get_group',
    args: { groupId: made.groupId },
  })
  assert.equal(
    currentGroup.group.participants.find((p) => p.id === bobPlaceholder.id)
      ?.name,
    'Bob',
  )
  assert.equal(currentGroup.context.kind, 'group')
  passed(
    'agent adds a new group participant, invites by email, and the verified account name takes over',
  )

  const expense = {
    title: 'Private dinner',
    amount: '60',
    currencyCode: 'USD',
    expenseDate: '2026-10-09',
    isReimbursement: false,
    paidBy: 'me',
    paidFor: [
      { participant: 'me', shares: '1' },
      { participant: 'friend', shares: '1' },
    ],
  }
  const people = [
    { kind: 'account', id: 'me', userId: alice.id },
    { kind: 'account', id: 'friend', userId: bob.id },
  ]
  const dinner = await call({
    name: 'create_expense',
    args: { expenseId: randomId(), people, expense },
  })
  const coffee = await call({
    name: 'create_expense',
    args: {
      expenseId: randomId(),
      people,
      expense: { ...expense, title: 'Coffee', amount: '10.01' },
    },
  })
  assert.notEqual(
    dinner.participants![0]!.participantId,
    coffee.participants![0]!.participantId,
  )
  assert.equal(
    (await call({ name: 'get_group', args: { groupId: dinner.groupId } }))
      .context.kind,
    'ungrouped',
  )
  assert(
    !(await call({ name: 'list_groups' })).groups.some(
      (g) => g.id === dinner.groupId,
    ),
  )
  passed(
    'create_expense works without groupId and safely reuses local person labels',
  )
  const summary = await call({ name: 'get_participant_balances' })
  assert.deepEqual(summary.totals, [{ currencyCode: 'USD', amount: '35' }])
  assert(summary.balances.some((balance) => balance.groupId === dinner.groupId))
  assert.deepEqual(
    (await call({ name: 'get_participant_balances', actor: outsider })).totals,
    [],
  )
  passed(
    'account totals are available through MCP without supplying groups and include private expenses',
  )

  const before = await prisma.expense.count()
  await rejects({
    name: 'create_expense',
    args: { groupId: 'missing-group', expense },
  })
  await rejects({
    name: 'create_expense',
    args: { groupId: made.groupId, expense },
  })
  await rejects({
    name: 'create_expense',
    args: { people, expense: { ...expense, paidBy: 'missing-person' } },
  })
  await rejects({
    name: 'create_expense',
    args: {
      people: [
        { kind: 'account', id: 'me', userId: alice.id },
        { kind: 'account', id: 'friend', userId: 'missing-account' },
      ],
      expense,
    },
  })
  await rejects({
    name: 'create_expense',
    args: {
      people,
      expense: {
        ...expense,
        splitMode: 'BY_AMOUNT',
        paidFor: [
          { participant: 'me', shares: '2' },
          { participant: 'friend', shares: '3' },
        ],
      },
    },
  })
  assert.equal(await prisma.expense.count(), before)
  await rejects({
    name: 'get_expense',
    actor: outsider,
    args: { groupId: dinner.groupId, expenseId: dinner.expenseId },
  })
  passed(
    'missing groups, forged participants/accounts, invalid splits and outsiders fail without writes',
  )

  const invited = await call({
    name: 'create_expense',
    args: {
      expenseId: randomId(),
      people: [
        people[0]!,
        {
          kind: 'email',
          id: 'friend',
          name: 'Guest placeholder',
          email: guest.email,
        },
      ],
      expense: { ...expense, title: 'Invited dinner' },
    },
  })
  const guestId = invited.participants!.find(
    (p) => p.localId === 'friend',
  )!.participantId
  await rejects({
    name: 'manage_group_access',
    actor: outsider,
    args: { action: 'join', shareUrl: invited.invitations![0]!.url },
  })
  const renewed = await call({
    name: 'manage_group_access',
    args: {
      action: 'renew_invitation',
      groupId: invited.groupId,
      participantId: guestId,
    },
  })
  await rejects({
    name: 'manage_group_access',
    actor: guest,
    args: { action: 'join', shareUrl: invited.invitations![0]!.url },
  })
  await call({
    name: 'manage_group_access',
    actor: guest,
    args: { action: 'join', shareUrl: renewed.invitation!.url },
  })
  assert(
    (await call({ name: 'list_all_expenses', actor: guest })).expenses.some(
      (e) => e.id === invited.expenseId,
    ),
  )
  passed(
    'email invitation creation, atomic renewal and correct-account acceptance work through MCP',
  )

  const historyBefore = await call({
    name: 'list_activity',
    args: { groupId: dinner.groupId, order: 'asc', limit: 100 },
  })
  const original = await call({
    name: 'get_expense',
    args: { groupId: dinner.groupId, expenseId: dinner.expenseId, revision: 1 },
  })
  await call({ name: 'update_profile', args: { name: 'Alice renamed' } })
  await rejects({
    name: 'update_profile',
    args: { name: 'Forged rename', userId: bob.id },
  })
  await rejects({ name: 'update_profile', args: { name: ' ' } })
  assert.equal(
    (
      await call({
        name: 'get_expense',
        args: { groupId: dinner.groupId, expenseId: dinner.expenseId },
      })
    ).expense.paidBy.name,
    'Alice renamed',
  )
  assert(
    (
      await call({ name: 'get_group', args: { groupId: made.groupId } })
    ).group.participants.some((p) => p.name === 'Alice renamed'),
  )
  assert.equal(
    (
      await call({
        name: 'get_expense',
        args: {
          groupId: dinner.groupId,
          expenseId: dinner.expenseId,
          revision: 1,
        },
      })
    ).history?.snapshot.expense.paidBy.name,
    original.history?.snapshot.expense.paidBy.name,
  )
  const historyAfter = await call({
    name: 'list_activity',
    args: { groupId: dinner.groupId, order: 'asc', limit: 100 },
  })
  assert.deepEqual(
    historyAfter.activities.map(({ snapshot, actorName }) => ({
      snapshot,
      actorName,
    })),
    historyBefore.activities.map(({ snapshot, actorName }) => ({
      snapshot,
      actorName,
    })),
  )
  const renamedExpense = await call({
    name: 'update_expense',
    args: {
      groupId: dinner.groupId,
      expenseId: dinner.expenseId,
      expectedRevision: dinner.revision,
      changes: { title: 'Renamed dinner' },
    },
  })
  const newSnapshot = await call({
    name: 'get_expense',
    args: {
      groupId: dinner.groupId,
      expenseId: dinner.expenseId,
      revision: renamedExpense.revision,
    },
  })
  assert.equal(
    newSnapshot.history?.snapshot.expense.paidBy.name,
    'Alice renamed',
  )
  assert.equal(newSnapshot.expense.attribution.updatedBy?.name, 'Alice renamed')
  await rejects({
    name: 'update_expense',
    args: {
      groupId: dinner.groupId,
      expenseId: dinner.expenseId,
      expectedRevision: dinner.revision,
      changes: { title: 'Stale edit' },
    },
  })
  passed(
    'one account name updates all current views, while old snapshots stay exact and new snapshots use the new name',
  )

  const me = dinner.participants!.find((p) => p.localId === 'me')!.participantId
  const friend = dinner.participants!.find(
    (p) => p.localId === 'friend',
  )!.participantId
  const payment = await call({
    name: 'create_expense',
    actor: bob,
    args: {
      groupId: dinner.groupId,
      expense: {
        title: 'Payment',
        amount: '30',
        currencyCode: 'USD',
        expenseDate: '2026-10-09',
        isReimbursement: true,
        paidBy: friend,
        paidFor: [{ participant: me, shares: '1' }],
      },
    },
  })
  assert.equal(
    (await call({ name: 'get_balances', args: { groupId: dinner.groupId } }))
      .currencies[0]!.reimbursements.length,
    0,
  )
  assert(
    (
      await call({
        name: 'list_all_expenses',
        args: { involvingMe: true, scope: 'ungrouped' },
      })
    ).expenses.some((e) => e.id === payment.expenseId),
  )
  await call({
    name: 'delete_expense',
    args: {
      groupId: dinner.groupId,
      expenseId: payment.expenseId,
      expectedRevision: payment.revision,
    },
  })
  await call({
    name: 'delete_expense',
    args: {
      groupId: dinner.groupId,
      expenseId: dinner.expenseId,
      expectedRevision: renamedExpense.revision,
    },
  })
  assert(
    (
      await call({ name: 'list_activity', args: { groupId: dinner.groupId } })
    ).activities.some((a) => a.activityType === 'DELETE_EXPENSE'),
  )
  passed(
    'repayment, balance, deletion and preserved history are all operable via the existing tools',
  )

  const denied = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-api-key': unverified.key,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  })
  assert.equal(denied.status, 401)
  passed('unverified accounts cannot use MCP')
  console.log(`${checks} HTTP MCP workflows passed`)
} finally {
  await prisma.apikey.updateMany({
    where: { id: { in: actors.map((actor) => actor.keyId) } },
    data: { enabled: false },
  })
  await prisma.$disconnect()
}
