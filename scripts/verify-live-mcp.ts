import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import {
  CallToolResultSchema,
  InitializeResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/core'
import sharp from 'sharp'
import { z } from 'zod'
import { MCP_OUTPUT_SCHEMAS } from '../src/lib/mcp/output-schemas'
import { MCP_TOOL_REGISTRY } from '../src/lib/mcp/registry'
import { randomId } from '../src/lib/random'
import { getExpenseShares } from '../src/lib/shares'

type Name = (typeof MCP_TOOL_REGISTRY)[number]['name']
type Output<N extends Name> = z.infer<
  (typeof MCP_OUTPUT_SCHEMAS)[Extract<
    (typeof MCP_TOOL_REGISTRY)[number],
    { name: N }
  >['procedure']]
>
assert.equal(process.env.AGENTSPLIT_VERIFY_ALLOW_WRITE, 'synthetic-expense')
const base = new URL(process.env.AGENTSPLIT_VERIFY_URL ?? '')
assert.equal(base.origin, 'https://agentsplit.freemanjiang.com')
const credential = z
  .object({ token: z.string() })
  .parse(
    JSON.parse(await readFile('.mcp-credentials/owner-codex.json', 'utf8')),
  )
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(new URL('/api/mcp', base), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  assert.equal(response.status, 200)
  const text = await response.text()
  const body = z
    .object({ result: z.unknown(), error: z.unknown().optional() })
    .parse(
      JSON.parse(
        text
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6) ?? text,
      ),
    )
  assert(!body.error)
  return body.result
}
async function call<N extends Name>(
  name: N,
  args: Record<string, unknown>,
): Promise<Output<N>> {
  const result = CallToolResultSchema.parse(
    await rpc('tools/call', { name, arguments: args }),
  )
  assert.notEqual(
    result.isError,
    true,
    `${name}: ${JSON.stringify(result.content)}`,
  )
  const definition = MCP_TOOL_REGISTRY.find((tool) => tool.name === name)!
  return MCP_OUTPUT_SCHEMAS[definition.procedure].parse(
    result.structuredContent,
  ) as Output<N>
}
const initialized = InitializeResultSchema.parse(
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'agentsplit-production-verifier', version: '1.0.0' },
  }),
)
assert.equal(initialized.serverInfo.version, '0.2.0')
const catalog = ListToolsResultSchema.parse(await rpc('tools/list'))
assert.equal(catalog.tools.length, 17)
assert(catalog.tools.every((tool) => tool.outputSchema?.type === 'object'))
assert.equal(
  catalog.tools.find((tool) => tool.name === 'create_expense')?.annotations
    ?.readOnlyHint,
  false,
)
const groups = await call('list_groups', {})
const group = groups.groups.find(
  (group) => group.name === 'AgentSplit deployment test',
)
assert(group, 'Only operate on the existing deployment-test group')
const details = await call('get_group', { groupId: group.id })
assert.equal(details.group.participants.length, 3)
const payer =
  details.group.participants.find((person) => person.name === 'Bob') ??
  details.group.participants[0]
const before = await call('list_expenses', { groupId: group.id, limit: 100 })
assert.equal(before.hasMore, false)
const beforeBalances = await call('get_balances', { groupId: group.id })
const bytes = await sharp({
  create: { width: 2, height: 3, channels: 3, background: '#00aa88' },
})
  .png()
  .toBuffer()
const expenseId = randomId()
let revision: number | undefined
let receiptUrl: string | undefined
try {
  const created = await call('create_expense', {
    groupId: group.id,
    expenseId,
    expense: {
      title: 'Synthetic full MCP readiness',
      expenseDate: new Date().toISOString().slice(0, 10),
      amount: '10',
      currencyCode: 'USD',
      paidBy: payer.id,
      paidFor: details.group.participants.map((person) => ({
        participant: person.id,
        shares: '1',
      })),
      isReimbursement: false,
    },
    uploads: [
      {
        filename: 'synthetic-readiness.png',
        contentType: 'image/png',
        bytes: bytes.length,
      },
    ],
  })
  revision = created.revision
  assert.equal(created.amount, '10')
  assert.equal(created.uploadError, null)
  assert.equal(created.uploads.length, 1)
  const target = created.uploads[0]
  const upload = await fetch(target.url, {
    method: target.method,
    headers: target.headers,
    body: bytes,
  })
  assert.equal(upload.status, 200, 'Direct Garage PUT failed')
  const attached = await call('update_expense', {
    groupId: group.id,
    expenseId,
    expectedRevision: revision,
    attachUploadIds: [target.uploadId],
    changes: { notes: 'Verified through MCP and direct Garage upload' },
  })
  revision = attached.revision
  const saved = await call('get_expense', { groupId: group.id, expenseId })
  assert.equal(saved.expense.documents.length, 1)
  const document = saved.expense.documents[0]
  receiptUrl = document.url
  assert.equal(document.width, 2)
  assert.equal(document.height, 3)
  const image = await fetch(receiptUrl)
  assert.equal(image.status, 200)
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes)
  const events = await call('list_activity', { groupId: group.id, expenseId })
  const latest = events.activities[0]
  assert(latest.actorUserId)
  assert(latest.agentKeyId)
  assert.equal(latest.source, 'agent')
  assert(latest.snapshot?.kind === 'expense')
  assert.equal(
    getExpenseShares({
      ...latest.snapshot.expense,
      paidById: latest.snapshot.expense.paidBy.id,
    }).get(payer.id),
    '3.34',
  )
  const conflict = CallToolResultSchema.parse(
    await rpc('tools/call', {
      name: 'update_expense',
      arguments: {
        groupId: group.id,
        expenseId,
        expectedRevision: 1,
        changes: { amount: '99' },
      },
    }),
  )
  assert.equal(conflict.isError, true)
  const yen = await call('update_expense', {
    groupId: group.id,
    expenseId,
    expectedRevision: revision,
    changes: { currencyCode: 'JPY' },
  })
  revision = yen.revision
  assert.equal(yen.amount, '10')
  const read = await call('get_expense', { groupId: group.id, expenseId })
  assert.equal(read.expense.currencyCode, 'JPY')
  assert.equal(read.expense.documents[0].url, receiptUrl)
  const exported = await call('export_group', {
    groupId: group.id,
    format: 'json',
  })
  assert.equal(
    z.object({ id: z.string() }).parse(JSON.parse(exported.content)).id,
    group.id,
  )
  await call('get_reference_data', {})
  console.log(
    'PASS discovery, schemas, committed writes, direct upload, permanent receipt, revisions, actor, rounding, currencies and export',
  )
} finally {
  if (revision !== undefined)
    await call('delete_expense', {
      groupId: group.id,
      expenseId,
      expectedRevision: revision,
    })
}
assert.deepEqual(
  await call('list_expenses', { groupId: group.id, limit: 100 }),
  before,
)
assert.deepEqual(
  await call('get_balances', { groupId: group.id }),
  beforeBalances,
)
const history = await call('list_activity', { groupId: group.id, expenseId })
assert.equal(history.activities[0].activityType, 'DELETE_EXPENSE')
assert(
  history.activities.some(
    (event) =>
      event.snapshot?.kind === 'expense' &&
      event.snapshot.expense.documents.some((doc) => doc.url === receiptUrl),
  ),
)
assert.equal((await fetch(receiptUrl!)).status, 200)
await writeFile(
  '/private/tmp/agentsplit-full-mcp-live-result.json',
  JSON.stringify(
    {
      serverVersion: initialized.serverInfo.version,
      tools: catalog.tools.length,
      groupId: group.id,
      expenseId,
      revisionCount: history.activities.length,
      uploadVerified: true,
      permanentReceiptRetained: true,
      originalLedgerRestored: true,
    },
    null,
    2,
  ),
  { mode: 0o600 },
)
console.log(
  'PASS cleanup, immutable history and receipt retention; original active ledger restored',
)
