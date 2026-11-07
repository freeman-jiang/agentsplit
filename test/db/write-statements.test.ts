// The SQL statements of one expense write. Each statement costs CPU in pg and
// Drizzle, so a change that adds statements to a write makes it slower
// (docs/v2/BASELINE.md, "Write CPU"). The ceilings
// are the counts after the statement reduction; raise one only on purpose.
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE, ok, startHarness, type Harness } from './mcp-harness'

// Each write takes one token from the fair-use write budget (src/server/rate-limit.ts): one statement more than before.
const CEILING = { mcpCreate: 10, mcpUpdateNotes: 10, webUpdate: 9 }

let h: Harness
let alice: Record<string, string>
let cookie: string

/** The statements the pg clients send while `work` runs. */
async function statements(work: () => Promise<unknown>): Promise<string[]> {
  const sent: string[] = []
  const original = pg.Client.prototype.query
  // Only this test replaces query, and only while `work` runs.
  pg.Client.prototype.query = function (this: pg.Client, ...args: Parameters<typeof original>) {
    const [config] = args
    sent.push(typeof config === 'string' ? config : (config as { text?: string } | undefined)?.text ?? '?')
    return Reflect.apply(original, this, args) as ReturnType<typeof original>
  } as typeof original
  try {
    await work()
  } finally {
    pg.Client.prototype.query = original
  }
  return sent
}

type Exit = { _tag: 'Exit'; exit: { _tag: 'Success'; value: unknown } | { _tag: 'Failure'; cause: unknown } }

/** One web RPC call, through the server's request handler (src/server/app.ts). */
async function webRpc(data: { tag: string; payload: object }) {
  const response = await h.app.fetch(
    new Request(`${BASE}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: BASE },
      body: JSON.stringify([{ _tag: 'Request', id: '1', tag: data.tag, payload: data.payload, headers: [] }]),
    }),
  )
  const [message] = (await response.json()) as Exit[]
  if (message?.exit._tag !== 'Success') throw new Error(`${data.tag} failed: ${JSON.stringify(message)}`)
  return message.exit.value
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
  h = await startHarness()
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
    const sent = await statements(() => ok(h, { name: 'create_expense', args: { groupId: 'g1', expenseId: id21(1), expense }, headers: alice }))
    console.log(`MCP create_expense: ${sent.length} statements\n${sent.join('\n')}`)
    expect(sent.length).toBeLessThanOrEqual(CEILING.mcpCreate)
  })

  it('MCP update_expense, notes only', async () => {
    const sent = await statements(() =>
      ok(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id21(1), expectedRevision: 1, changes: { notes: 'Split two ways' } }, headers: alice }),
    )
    console.log(`MCP update_expense: ${sent.length} statements\n${sent.join('\n')}`)
    expect(sent.length).toBeLessThanOrEqual(CEILING.mcpUpdateNotes)
  })

  it('web expenses.update, and its retry with the same key', async () => {
    const payload = { groupId: 'g1', expenseId: id21(1), expectedRevision: 2, idempotencyKey: 'web-update-0001', expense: webDraft('Edited on the web') }
    let first: unknown
    const sent = await statements(async () => {
      first = await webRpc({ tag: 'expenses.update', payload })
    })
    console.log(`web expenses.update: ${sent.length} statements\n${sent.join('\n')}`)
    expect(sent.length).toBeLessThanOrEqual(CEILING.webUpdate)
    // A retry gets the stored result and adds no revision.
    expect(await webRpc({ tag: 'expenses.update', payload })).toEqual(first)
    expect(first).toMatchObject({ revision: 3, notes: 'Edited on the web' })
  })
})
