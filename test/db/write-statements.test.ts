// The SQL statements of one expense write. Each statement costs CPU in pg and
// Drizzle, so a change that adds statements to a write makes it slower
// (docs/v2/BASELINE.md, "Write CPU"). The ceilings
// are the counts after the statement reduction; raise one only on purpose.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE, callTool, ok, startHarness, type Harness } from './harness'

// Each write takes one token from the fair-use write budget (src/server/rate-limit.ts): one statement more than before.
const CEILING = { mcpCreate: 10, mcpUpdateNotes: 10, webUpdate: 9 }

let h: Harness
let alice: Record<string, string>
let cookie: string

/** The statements of one request, as PERF_INSTRUMENTATION reports them (perf.ts). */
const statements = (response: { headers: Headers }) => Number(response.headers.get('x-perf-db-queries'))

/** One MCP tool call; returns the statements it sent. */
async function mcpCall(data: { name: string; args: object }): Promise<number> {
  const reply = await callTool(h, { ...data, headers: alice })
  if (reply.status !== 200 || reply.result?.isError) throw new Error(`${data.name} failed: ${JSON.stringify(reply.body)}`)
  return statements(reply)
}

type Exit = { _tag: 'Exit'; exit: { _tag: 'Success'; value: unknown } | { _tag: 'Failure'; cause: unknown } }

/** One web RPC call through the app; returns its value and the statements it sent. */
async function webRpc(data: { tag: string; payload: object }) {
  const response = await h.fetch(
    new Request(`${BASE}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: BASE },
      body: JSON.stringify([{ _tag: 'Request', id: '1', tag: data.tag, payload: data.payload, headers: [] }]),
    }),
  )
  const [message] = (await response.json()) as Exit[]
  if (message?.exit._tag !== 'Success') throw new Error(`${data.tag} failed: ${JSON.stringify(message)}`)
  return { value: message.exit.value, statements: statements(response) }
}

const id21 = (n: number) => `w${String(n).padStart(20, '0')}`

const expense = {
  title: 'Dinner',
  expenseDate: '2026-11-01',
  amount: '30',
  currencyCode: 'USD',
  paidBy: 'pa',
  paidFor: [
    { participant: 'pa', shares: '1' },
    { participant: 'pb', shares: '1' },
  ],
  isReimbursement: false,
}

const webDraft = (notes: string) => ({
  kind: 'expense',
  title: 'Dinner',
  vendor: null,
  notes,
  categoryId: 0,
  expenseDate: '2026-11-01',
  currency: 'USD',
  amount: '30.00',
  payers: [{ participantId: 'pa', amount: '30.00' }],
  splitMode: 'evenly',
  shares: [
    { participantId: 'pa', weight: '1' },
    { participantId: 'pb', weight: '1' },
  ],
  recurrence: 'none',
})

beforeAll(async () => {
  h = await startHarness({ perf: true })
  cookie = (await h.account('alice', { name: 'Alice' })).cookie
  await h.account('bob', { name: 'Bob' })
  await h.group({ id: 'g1', name: 'Home', people: ['pa', 'pb'], members: [['alice', 'pa', 'admin'], ['bob', 'pb', 'member']] })
  alice = { 'x-api-key': await h.apiKey('alice') }
  // Warm up: the first call loads modules and the API key's first use writes more.
  await ok(h, { name: 'create_expense', args: { groupId: 'g1', expenseId: id21(0), expense }, headers: alice })
})
afterAll(() => h.close())

describe('statements per expense write', () => {
  it('MCP create_expense', async () => {
    expect(await mcpCall({ name: 'create_expense', args: { groupId: 'g1', expenseId: id21(1), expense } })).toBeLessThanOrEqual(CEILING.mcpCreate)
  })

  it('MCP update_expense, notes only', async () => {
    await ok(h, { name: 'create_expense', args: { groupId: 'g1', expenseId: id21(2), expense }, headers: alice })
    const sent = await mcpCall({ name: 'update_expense', args: { groupId: 'g1', expenseId: id21(2), expectedRevision: 1, changes: { notes: 'Split two ways' } } })
    expect(sent).toBeLessThanOrEqual(CEILING.mcpUpdateNotes)
  })

  it('web expenses.update, and its retry with the same key', async () => {
    await ok(h, { name: 'create_expense', args: { groupId: 'g1', expenseId: id21(3), expense }, headers: alice })
    const payload = { groupId: 'g1', expenseId: id21(3), expectedRevision: 1, idempotencyKey: 'web-update-0001', expense: webDraft('Edited on the web') }
    const first = await webRpc({ tag: 'expenses.update', payload })
    expect(first.statements).toBeLessThanOrEqual(CEILING.webUpdate)
    // A retry gets the stored result and adds no revision.
    expect((await webRpc({ tag: 'expenses.update', payload })).value).toEqual(first.value)
    expect(first.value).toMatchObject({ revision: 2, notes: 'Edited on the web' })
  })
})
