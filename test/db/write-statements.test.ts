// The SQL statements of one expense write. Each statement costs CPU in pg and
// Drizzle, so a change that adds statements to a write makes it slower
// (docs/v2/BASELINE.md, "Write CPU"). Raise a ceiling only on purpose.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { draft, mcpExpense } from '../kit/drafts'
import { id21 } from '../kit/ids'
import { callTool, ok, startHarness, webRpc, type Harness } from './harness'

// The fair-use write budget (src/server/rate-limit.ts) takes one statement of each write.
const CEILING = { mcpCreate: 10, mcpUpdateNotes: 10, webUpdate: 9 }

let h: Harness
let alice: Record<string, string>
let cookie: string

/** The statements of one request, as PERF_INSTRUMENTATION reports them (perf.ts). */
function statements(response: { headers: Headers }): number {
  const header = response.headers.get('x-perf-db-queries')
  if (header === null) throw new Error('The answer has no x-perf-db-queries header')
  return Number(header)
}

/** One MCP tool call; returns the statements it sent. */
async function mcpCall(data: { name: string; args: object }): Promise<number> {
  const reply = await callTool(h, { ...data, headers: alice })
  if (reply.status !== 200 || reply.result?.isError) throw new Error(`${data.name} failed: ${JSON.stringify(reply.body)}`)
  return statements(reply)
}

/** One web RPC call through the app; returns its value and the statements it sent. */
async function web(data: { tag: string; payload: object }) {
  const { response, exit } = await webRpc(h, { ...data, cookie })
  if (exit._tag !== 'Success') throw new Error(`${data.tag} failed: ${JSON.stringify(exit)}`)
  return { value: exit.value, statements: statements(response) }
}

const expenseId = (n: number) => id21('w', n)
const expense = mcpExpense({ paidBy: 'pa', people: ['pa', 'pb'] })
const webDraft = (notes: string) => draft({ payer: 'pa', people: ['pa', 'pb'], title: 'Dinner', amount: '30.00', notes })

beforeAll(async () => {
  h = await startHarness({ perf: true })
  cookie = (await h.account('alice', { name: 'Alice' })).cookie
  await h.account('bob', { name: 'Bob' })
  await h.group({ id: 'g1', name: 'Home', people: ['pa', 'pb'], members: [['alice', 'pa', 'admin'], ['bob', 'pb', 'member']] })
  alice = { 'x-api-key': await h.apiKey('alice') }
  // Warm up: the first call loads modules and the API key's first use writes more.
  await ok(h, { name: 'create_expense', args: { groupId: 'g1', expenseId: expenseId(0), expense }, headers: alice })
})
afterAll(() => h.close())

describe('statements per expense write', () => {
  it('MCP create_expense', async () => {
    expect(await mcpCall({ name: 'create_expense', args: { groupId: 'g1', expenseId: expenseId(1), expense } })).toBeLessThanOrEqual(CEILING.mcpCreate)
  })

  it('MCP update_expense, notes only', async () => {
    await ok(h, { name: 'create_expense', args: { groupId: 'g1', expenseId: expenseId(2), expense }, headers: alice })
    const sent = await mcpCall({ name: 'update_expense', args: { groupId: 'g1', expenseId: expenseId(2), expectedRevision: 1, changes: { notes: 'Split two ways' } } })
    expect(sent).toBeLessThanOrEqual(CEILING.mcpUpdateNotes)
  })

  it('web expenses.update, and its retry with the same key', async () => {
    await ok(h, { name: 'create_expense', args: { groupId: 'g1', expenseId: expenseId(3), expense }, headers: alice })
    const payload = { groupId: 'g1', expenseId: expenseId(3), expectedRevision: 1, idempotencyKey: 'web-update-0001', expense: webDraft('Edited on the web') }
    const first = await web({ tag: 'expenses.update', payload })
    expect(first.statements).toBeLessThanOrEqual(CEILING.webUpdate)
    // A retry gets the stored result and adds no revision.
    expect((await web({ tag: 'expenses.update', payload })).value).toEqual(first.value)
    expect(first.value).toMatchObject({ revision: 2, notes: 'Edited on the web' })
  })
})
