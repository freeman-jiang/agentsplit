import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/core'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import superjson from 'superjson'
import * as z from 'zod'
import { expenseSnapshotSchema } from '../src/lib/expense-history'
import { expenseFormSchema } from '../src/lib/schemas'
import type { AppRouter } from '../src/trpc/routers/_app'

// This opt-in runner creates, edits, and soft-deletes ONE synthetic expense.
// It refuses to touch groups that aren't explicitly labeled deployment tests.
assert.equal(process.env.AGENTSPLIT_VERIFY_ALLOW_WRITE, 'synthetic-expense')
const base = new URL(process.env.AGENTSPLIT_VERIFY_URL ?? '')
assert.equal(base.protocol, 'https:')
const { token } = z
  .object({ token: z.string() })
  .parse(
    JSON.parse(
      await readFile(
        process.env.AGENTSPLIT_VERIFY_CREDENTIAL_FILE ??
          '.mcp-credentials/owner-codex.json',
        'utf8',
      ),
    ),
  )
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(new URL('/api/mcp', base), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  assert.equal(response.status, 200)
  const text = await response.text()
  return z.object({ result: z.unknown() }).parse(
    JSON.parse(
      text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6) ?? text,
    ),
  ).result
}
async function call(name: string, args: Record<string, unknown>) {
  const result = CallToolResultSchema.parse(
    await rpc('tools/call', { name, arguments: args }),
  )
  assert.notEqual(result.isError, true, `Tool ${name} failed`)
  return result.structuredContent
}
const catalog = ListToolsResultSchema.parse(await rpc('tools/list'))
assert.equal(catalog.tools.length, 11)
const groups = z
  .object({ groups: z.array(z.object({ id: z.string(), name: z.string() })) })
  .parse(await call('list_groups', {})).groups
const group = groups.find(
  (group) => group.name === 'AgentSplit deployment test',
)
assert(group, 'Use only the existing synthetic deployment-test group')
const details = z
  .object({
    group: z.object({
      participants: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  })
  .parse(await call('get_group', { groupId: group.id }))
assert.equal(details.group.participants.length, 3)
const before = await call('list_expenses', { groupId: group.id, limit: 100 })
const balancesBefore = await call('get_balances', { groupId: group.id })
const beforePage = z
  .object({
    expenses: z.array(z.object({ id: z.string() })),
    hasMore: z.boolean(),
  })
  .parse(before)
assert.equal(beforePage.hasMore, false)
assert(beforePage.expenses.length > 0)
const saved = z
  .object({
    expense: z.object({
      documents: z.array(
        z.object({
          id: z.string(),
          url: z.string(),
          width: z.number(),
          height: z.number(),
        }),
      ),
    }),
  })
  .parse(
    await call('get_expense', {
      groupId: group.id,
      expenseId: beforePage.expenses[0].id,
    }),
  )
const client = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: new URL('/api/trpc', base).href,
      transformer: superjson,
    }),
  ],
})
const [alice, bob, carol] = details.group.participants
assert(alice && bob && carol)
const form = expenseFormSchema.parse({
  title: 'Synthetic audit verification',
  amount: 6000,
  expenseDate: new Date('2026-09-30T00:00:00Z'),
  category: 0,
  paidBy: alice.id,
  paidFor: [alice, bob, carol].map((person) => ({
    participant: person.id,
    shares: 1,
  })),
  splitMode: 'EVENLY',
  isReimbursement: false,
  saveDefaultSplittingOptions: false,
  originalCurrency: null,
  documents: saved.expense.documents.slice(0, 1),
  notes: 'Synthetic verification only',
  recurrenceRule: 'NONE',
})
const created = await client.groups.expenses.create.mutate({
  groupId: group.id,
  expenseFormValues: form,
  participantId: alice.id,
})
try {
  await client.groups.expenses.update.mutate({
    groupId: group.id,
    expenseId: created.expenseId,
    participantId: bob.id,
    expenseFormValues: {
      ...form,
      amount: 9000,
      splitMode: 'BY_SHARES',
      paidFor: [
        { participant: alice.id, shares: 1 },
        { participant: bob.id, shares: 3 },
        { participant: carol.id, shares: 2 },
      ],
    },
  })
  const history = z
    .object({
      activities: z.array(
        z.object({
          expenseRevision: z.number(),
          snapshot: expenseSnapshotSchema.nullable(),
        }),
      ),
    })
    .parse(
      await call('list_activity', {
        groupId: group.id,
        expenseId: created.expenseId,
        limit: 100,
      }),
    )
  assert.deepEqual(
    history.activities.map((event) => event.expenseRevision),
    [2, 1],
  )
  assert.equal(history.activities[0].snapshot?.expense.amount, 9000)
  assert.equal(history.activities[1].snapshot?.expense.amount, 6000)
  assert.deepEqual(
    history.activities[0].snapshot?.expense.documents.map(
      (document) => document.url,
    ),
    form.documents.map((document) => document.url),
  )
} finally {
  await client.groups.expenses.delete.mutate({
    groupId: group.id,
    expenseId: created.expenseId,
    participantId: alice.id,
  })
}
const history = z
  .object({
    activities: z.array(
      z.object({
        expenseRevision: z.number(),
        activityType: z.string(),
        snapshot: expenseSnapshotSchema.nullable(),
        previousSnapshot: expenseSnapshotSchema.nullable(),
      }),
    ),
  })
  .parse(
    await call('list_activity', {
      groupId: group.id,
      expenseId: created.expenseId,
      limit: 100,
    }),
  )
assert.deepEqual(
  history.activities.map((event) => event.expenseRevision),
  [3, 2, 1],
)
assert.equal(history.activities[0].activityType, 'DELETE_EXPENSE')
assert.equal(history.activities[0].snapshot, null)
assert.equal(history.activities[0].previousSnapshot?.expense.amount, 9000)
assert.deepEqual(
  await call('list_expenses', { groupId: group.id, limit: 100 }),
  before,
)
assert.deepEqual(
  await call('get_balances', { groupId: group.id }),
  balancesBefore,
)
await writeFile(
  '/private/tmp/agentsplit-live-audit-result.json',
  JSON.stringify(
    {
      groupId: group.id,
      expenseId: created.expenseId,
      revisions: [3, 2, 1],
      tools: 11,
      originalExpensesAndBalancesUnchanged: true,
    },
    null,
    2,
  ),
  { mode: 0o600 },
)
console.log(
  JSON.stringify({
    tools: 11,
    preservedRevisions: 3,
    receiptPointersRetained: true,
    originalExpensesAndBalancesUnchanged: true,
  }),
)
