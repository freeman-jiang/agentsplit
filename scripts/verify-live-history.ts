/** Read-only production probe using an already-deleted synthetic expense. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { MCP_OUTPUT_SCHEMAS } from '../src/lib/mcp/output-schemas'

const base = 'https://agentsplit.freemanjiang.com'
const credential = z
  .object({ token: z.string() })
  .parse(
    JSON.parse(await readFile('.mcp-credentials/owner-codex.json', 'utf8')),
  )
async function call(name: string, args: Record<string, unknown>) {
  const response = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential.token}`,
      'content-type': 'application/json',
      accept: 'application/json,text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  assert.equal(response.status, 200)
  const text = await response.text()
  const body = z
    .object({
      result: z.object({
        isError: z.boolean().optional(),
        structuredContent: z.unknown(),
      }),
    })
    .parse(
      JSON.parse(
        text
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6) ?? text,
      ),
    )
  assert(!body.result.isError, `Historical tool failed: ${name}`)
  return body.result.structuredContent
}
const groups = MCP_OUTPUT_SCHEMAS['groups.list'].parse(
  await call('list_groups', {}),
)
const group = groups.groups.find((g) => g.name === 'AgentSplit deployment test')
assert(group)
const groupId = group.id
const history = MCP_OUTPUT_SCHEMAS['groups.activities.list'].parse(
  await call('list_activity', {
    groupId,
    activityType: 'DELETE_EXPENSE',
    limit: 100,
  }),
)
const removed = history.activities.find(
  (event) => event.previousSnapshot?.kind === 'expense',
)
assert(removed?.expenseId)
assert(removed.previousSnapshot?.kind === 'expense')
const before = removed.previousSnapshot.expense
const original = MCP_OUTPUT_SCHEMAS['groups.expenses.get'].parse(
  await call('get_expense', {
    groupId,
    expenseId: removed.expenseId,
    revision: before.revision,
  }),
)
assert.equal(original.expense.amount, before.amount)
assert.equal(original.expense.currencyCode, before.currencyCode)
assert.equal(original.history?.deleted, false)
assert(original.history)
const atOriginal = MCP_OUTPUT_SCHEMAS['groups.expenses.list'].parse(
  await call('list_expenses', {
    groupId,
    atActivityId: original.history.activityId,
    limit: 100,
  }),
)
assert(atOriginal.history?.complete)
assert(
  atOriginal.expenses.some(
    (e) => e.id === removed.expenseId && e.amount === before.amount,
  ),
)
const balances = MCP_OUTPUT_SCHEMAS['groups.balances.list'].parse(
  await call('get_balances', {
    groupId,
    atActivityId: original.history.activityId,
  }),
)
assert(balances.history?.complete)
assert(balances.currencies.some((c) => c.currencyCode === before.currencyCode))
const atDeletion = MCP_OUTPUT_SCHEMAS['groups.expenses.list'].parse(
  await call('list_expenses', {
    groupId,
    atActivityId: removed.id,
    limit: 100,
  }),
)
assert(!atDeletion.expenses.some((e) => e.id === removed.expenseId))
const deletion = MCP_OUTPUT_SCHEMAS['groups.expenses.get'].parse(
  await call('get_expense', {
    groupId,
    expenseId: removed.expenseId,
    revision: removed.expenseRevision,
  }),
)
assert.equal(deletion.history?.deleted, true)
assert.equal(deletion.history.snapshot.expense.amount, before.amount)
const chronological = MCP_OUTPUT_SCHEMAS['groups.activities.list'].parse(
  await call('list_activity', {
    groupId,
    expenseId: removed.expenseId,
    order: 'asc',
    recordedFrom: original.history.recordedAt,
    recordedTo: removed.time,
    atActivityId: removed.id,
    limit: 100,
  }),
)
assert(chronological.activities.length >= 2)
assert(chronological.activities.every((e) => e.expense === undefined))
const byTime = MCP_OUTPUT_SCHEMAS['groups.expenses.get'].parse(
  await call('get_expense', {
    groupId,
    expenseId: removed.expenseId,
    asOf: original.history.recordedAt,
  }),
)
assert.equal(byTime.expense.amount, before.amount)
const report = {
  revisionRead: true,
  historicalLedger: true,
  historicalBalances: true,
  deletionRetained: true,
  preciseChronologicalHistory: true,
  timestampRead: true,
  readOnly: true,
}
await writeFile(
  '/private/tmp/agentsplit-live-history-result.json',
  JSON.stringify(report, null, 2) + '\n',
)
console.log(
  'PASS live revision, timestamp, historical ledger/balances, deletion and chronological audit queries; no ledger writes performed',
)
