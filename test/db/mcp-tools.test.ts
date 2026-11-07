// The MCP endpoint, the tool advertisement, and the group and expense tools,
// over HTTP in process, against a real database. Parity items are named in
// docs/v2/parity/mcp.md.
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GROUP_DENIED } from '~/shared/errors'
import { activities, expenses, mcpRateLimits, memberships } from '../../db/schema/app'
import { MCP_TOOLS } from '~/server/mcp/tools'
import { takeMcpRequest } from '~/server/rate-limit'
import { LIMITS } from '~/shared/limits'
import { mcpExpense, type McpExpenseChanges } from '../kit/drafts'
import { id21 } from '../kit/ids'
import current from './fixtures/current-mcp-tools.json'
import { BASE, callTool, checked as checkedCall, failure, type Harness, MCP_URL, rpc, startHarness } from './harness'

let h: Harness
let alice: Record<string, string>
let aliceKeyId: string
let bob: Record<string, string>

let expenseCount = 0
/** A new 21-character expense ID. */
const newExpenseId = () => id21('e', ++expenseCount)

beforeAll(async () => {
  h = await startHarness()
  await h.account('alice', { name: 'Alice' })
  await h.account('bob', { name: 'Bob' })
  await h.account('carol', { name: 'Carol', verified: false })
  await h.group({ id: 'g1', name: 'Home', slug: 'home', people: ['pa', 'pb', 'pc'], members: [['alice', 'pa', 'admin'], ['bob', 'pb', 'member']] })
  await h.group({ id: 'g2', name: 'Trip', people: ['qa'], members: [['alice', 'qa', 'admin']] })
  await h.group({ id: 'g3', name: 'Bob only', people: ['rb'], members: [['bob', 'rb', 'admin']] })
  await h.privateContext({ owner: 'alice', expenseId: 'private-dinner' })
  const aliceKey = await h.apiKeyWithId('alice')
  alice = { 'x-api-key': aliceKey.key }
  aliceKeyId = aliceKey.id
  bob = { authorization: `Bearer ${await h.apiKey('bob')}` }
})
afterAll(() => h.close())

/** A successful call whose result decodes with the tool's advertised output schema. */
const checked = (name: string, args: object, headers = alice) => checkedCall(h, { name, args, headers })

/** The create_expense argument in g1: 30 paid by Alice, one share each for Alice, Bob and pc. */
const expense = (over: McpExpenseChanges = {}) => mcpExpense({ paidBy: 'pa', people: ['pa', 'pb', 'pc'], ...over })

/**
 * A new account (named Lena) with an API key, admin of a new group of three
 * people. A test that reads a whole group, or changes memberships, works here,
 * so the fixtures of the other tests stay as beforeAll made them.
 */
async function household(tag: string, data: { slug?: string } = {}) {
  const owner = `${tag}-owner`
  await h.account(owner, { name: 'Lena' })
  const groupId = `g-${tag}`
  const [a, b, c] = [`${tag}-a`, `${tag}-b`, `${tag}-c`]
  await h.group({ id: groupId, ...(data.slug ? { slug: data.slug } : {}), people: [a, b, c], members: [[owner, a, 'admin']] })
  const headers = { 'x-api-key': await h.apiKey(owner) }
  return { owner, groupId, a, b, c, headers, expense: (over: McpExpenseChanges = {}) => mcpExpense({ paidBy: a, people: [a, b, c], ...over }) }
}

describe('protocol', () => {
  it('initializes legacy 2025 clients with the instructions and server info', async () => {
    for (const protocolVersion of ['2025-03-26', '2025-06-18']) {
      const r = await rpc(h, { method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'codex', version: '1' } }, headers: alice })
      expect(r.status).toBe(200)
      const result = (r.body as { result: { protocolVersion: string; serverInfo: unknown; instructions: string } }).result
      expect(result.protocolVersion).toBe(protocolVersion)
      expect(result.serverInfo).toEqual({ name: 'agentsplit', version: '0.4.0' })
      // The current app's money and naming rules stay in the text (P-MCP-06).
      expect(result.instructions).toContain('decimal strings')
      expect(result.instructions).toContain('global')
      expect(result.instructions).not.toContain('minor units')
      expect(r.headers.get('cache-control')).toBe('no-store')
    }
  })

  const modern = (method: string, name?: string) => ({
    jsonrpc: '2.0',
    id: 8,
    method,
    params: {
      ...(name ? { name, arguments: { groupId: 'g1' } } : {}),
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  })

  it.each<[string, string | undefined]>([['tools/list', undefined], ['tools/call', 'get_group']])('serves modern %s requests and checks the standard headers', async (method, name) => {
    const headers: Record<string, string> = {
      ...alice,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...(name ? { 'Mcp-Name': name } : {}),
    }
    const body = JSON.stringify(modern(method, name))
    const r = await h.fetch(new Request(MCP_URL, { method: 'POST', headers, body }))
    expect(r.status).toBe(200)
    const reply = (await r.json()) as { result: { tools?: unknown[]; isError?: boolean; structuredContent?: unknown } }
    if (name) expect(reply.result).toMatchObject({ structuredContent: { group: { id: 'g1' } } })
    else expect(reply.result.tools).toHaveLength(MCP_TOOLS.length)
    const mismatch = await h.fetch(new Request(MCP_URL, { method: 'POST', headers: { ...headers, 'Mcp-Method': 'wrong-method' }, body }))
    expect(mismatch.status).toBe(400)
    expect(((await mismatch.json()) as { error: { code: number } }).error.code).toBe(-32020)
  })

  it('requires MCP-Protocol-Version on modern requests, with the request ID', async () => {
    const body = { ...modern('tools/list'), id: 'modern-check' }
    const r = await h.fetch(
      new Request(MCP_URL, { method: 'POST', headers: { ...alice, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'Mcp-Method': 'tools/list' }, body: JSON.stringify(body) }),
    )
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ jsonrpc: '2.0', id: 'modern-check', error: { code: -32020, message: 'MCP-Protocol-Version is required' } })
    expect(r.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses another host or origin, and allows requests without Origin', async () => {
    const headers = { ...alice, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    for (const extra of [{ origin: 'https://evil.example' }, { host: 'evil.example' }]) {
      const r = await h.fetch(new Request(MCP_URL, { method: 'POST', headers: { ...headers, ...extra }, body }))
      expect(r.status).toBe(403)
      expect(await r.json()).toEqual({ error: 'Origin or host is not allowed' })
      expect(r.headers.get('cache-control')).toBe('no-store')
    }
    const same = await h.fetch(new Request(MCP_URL, { method: 'POST', headers: { ...headers, origin: BASE }, body }))
    expect(same.status).toBe(200)
  })

  it('answers GET and DELETE with the SDK’s stateless 405', async () => {
    for (const method of ['GET', 'DELETE']) {
      const r = await h.fetch(new Request(MCP_URL, { method, headers: alice }))
      expect(r.status).toBe(405)
      expect(r.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('isolates two concurrent users with identical JSON-RPC IDs', async () => {
    const [a, b] = await Promise.all([callTool(h, { name: 'list_groups', headers: alice }), callTool(h, { name: 'list_groups', headers: bob })])
    const ids = (r: typeof a) => (r.result?.structuredContent?.['groups'] as { id: string }[]).map((g) => g.id).sort()
    expect(ids(a)).toEqual(['g1', 'g2'])
    expect(ids(b)).toEqual(['g1', 'g3'])
  })

  it('rejects an unknown tool and the removed month tool without running anything', async () => {
    for (const name of ['list_month_expenses', 'no_such_tool']) {
      const r = await callTool(h, { name, headers: alice })
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ error: { code: -32602, message: `Tool ${name} not found` } })
    }
  })
})

describe('tool advertisement', () => {
  type Advertised = { name: string; annotations: unknown; securitySchemes: unknown; _meta: unknown; inputSchema: JsonNode; outputSchema: JsonNode }
  type JsonNode = { type?: string; properties?: Record<string, JsonNode>; required?: string[]; additionalProperties?: boolean; items?: JsonNode; enum?: string[] }

  it('advertises the current names, annotations, scopes and input fields', async () => {
    const r = await rpc(h, { method: 'tools/list', headers: alice })
    const tools = (r.body as { result: { tools: Advertised[] } }).result.tools
    // v2 adds the storage tools at the end; every current tool keeps its place.
    expect(tools.map((t) => t.name)).toEqual([...current.tools.map((t) => t.name), 'get_storage_usage', 'list_receipts', 'delete_receipts'])
    for (const before of current.tools as unknown as Advertised[]) {
      const now = tools.find((t) => t.name === before.name)
      if (!now) throw new Error(before.name)
      expect({ name: now.name, annotations: now.annotations, securitySchemes: now.securitySchemes, _meta: now._meta }).toEqual({
        name: before.name,
        annotations: before.annotations,
        securitySchemes: before.securitySchemes,
        _meta: before._meta,
      })
      expect(now.inputSchema['$schema' as keyof JsonNode]).toBe('https://json-schema.org/draft/2020-12/schema')
      // The same strict objects, fields, required fields and enums, recursively.
      const compare = (a: JsonNode | undefined, b: JsonNode | undefined, path: string) => {
        if (!a || !b) return
        expect({ path, closed: a.additionalProperties === false }).toEqual({ path, closed: b.additionalProperties === false })
        if (b.enum) expect({ path, enum: [...(a.enum ?? [])].sort() }).toEqual({ path, enum: [...b.enum].sort() })
        if (b.properties) {
          // v2 adds `payers` beside paidBy; every current field stays.
          const added = Object.keys(a.properties ?? {}).filter((k) => !(k in (b.properties ?? {})))
          expect({ path, missing: Object.keys(b.properties).filter((k) => !(k in (a.properties ?? {}))) }).toEqual({ path, missing: [] })
          expect({ path, added }).toEqual({ path, added: path === 'create_expense.expense' || path === 'update_expense.changes' ? ['payers'] : [] })
          // paidBy became optional because payers can replace it; nothing else changed.
          const required = (b.required ?? []).filter((k) => k !== 'paidBy')
          expect({ path, required: [...(a.required ?? [])].sort() }).toEqual({ path, required: required.sort() })
          for (const key of Object.keys(b.properties)) compare(a.properties?.[key], b.properties[key], `${path}.${key}`)
        }
        compare(a.items, b.items, `${path}[]`)
      }
      compare(now.inputSchema, before.inputSchema, now.name)
      expect(now.outputSchema.type).toBe('object')
      // Every current output field is still there.
      const outputs = (a: JsonNode | undefined, b: JsonNode | undefined, path: string) => {
        if (!a || !b?.properties) return
        const missing = Object.keys(b.properties).filter((k) => !(k in (a.properties ?? {})))
        expect({ path, missing }).toEqual({ path, missing: [] })
        for (const key of Object.keys(b.properties)) outputs(a.properties?.[key], b.properties[key], `${path}.${key}`)
        outputs(a.items, b.items, `${path}[]`)
      }
      outputs(now.outputSchema, before.outputSchema, now.name)
    }
  })
})

describe('list_groups and get_group', () => {
  it('lists named groups of active memberships only, newest first, and pages', async () => {
    const all = await checked('list_groups', {})
    expect((all['groups'] as { id: string }[]).map((g) => g.id)).toEqual(['g2', 'g1'])
    const first = await checked('list_groups', { limit: 1 })
    expect(first).toMatchObject({ hasMore: true, nextCursor: 1 })
    const second = await checked('list_groups', { limit: 1, cursor: 1 })
    expect(second).toMatchObject({ hasMore: false, nextCursor: 2 })
    expect((second['groups'] as { id: string; currency: string; currencyCode: string; _count: unknown }[])[0]).toMatchObject({
      id: 'g1',
      slug: 'home',
      currency: '$',
      currencyCode: 'USD',
      revision: 1,
      _count: { participants: 3 },
    })
  })

  it('fails the whole call when one requested group is not the caller’s', async () => {
    expect((await checked('list_groups', { groupIds: ['g1'] }))['groups']).toHaveLength(1)
    const denied = await failure(h, { name: 'list_groups', args: { groupIds: ['g1', 'g3'] }, headers: alice })
    // The agent-facing text, worded as in v1; the other tests compare with GROUP_DENIED.
    expect(denied).toEqual({ code: 'FORBIDDEN', message: 'Group not found, or you are not a member', outcomeUnknown: false, recovery: 'correct_arguments' })
  })

  it('reads a group with access, names, members, reserved IDs, expense participants and links', async () => {
    const result = await checked('get_group', { groupId: 'g1' })
    expect(result['context']).toEqual({ kind: 'group', expenseId: null })
    expect(result['links']).toEqual({ share: `${BASE}/home`, csv: `${BASE}/home/expenses/export/csv`, json: `${BASE}/home/expenses/export/json` })
    const group = result['group'] as { participants: { id: string; name: string; groupId: string }[] }
    // A bound verified account names its participant; others keep their placeholder.
    expect(group.participants).toEqual([
      { id: 'pa', name: 'Alice', groupId: 'g1' },
      { id: 'pb', name: 'Bob', groupId: 'g1' },
      { id: 'pc', name: 'Name pc', groupId: 'g1' },
    ])
    expect(result['access']).toMatchObject({ role: 'admin', participantId: 'pa', reservedParticipantIds: ['pa', 'pb'], invitations: [] })
    expect((result['access'] as { members: unknown[] }).members).toHaveLength(2)
    const bobs = await checked('get_group', { groupId: 'g1' }, bob)
    expect(bobs['access']).toMatchObject({ role: 'member', participantId: 'pb' })
  })

  it('denies a group of someone else with a certain outcome', async () => {
    for (const groupId of ['g3', 'missing-group']) {
      const denied = await failure(h, { name: 'get_group', args: { groupId }, headers: alice })
      expect(denied).toMatchObject({ code: 'FORBIDDEN', message: GROUP_DENIED, outcomeUnknown: false })
    }
  })
})

describe('expense writes and reads', () => {
  it('creates with a stable ID, and a reused ID is a Conflict in any group', async () => {
    const id = newExpenseId()
    const created = await checked('create_expense', { groupId: 'g1', expenseId: id, expense: expense({ vendor: 'Nopa', notes: '3 x 10 = 30' }) })
    expect(created).toEqual({ groupId: 'g1', expenseId: id, revision: 1, amount: '30.00', currencyCode: 'USD', uploads: [], uploadError: null })
    for (const [groupId, payer] of [['g1', 'pa'], ['g2', 'qa']] as const) {
      const again = await failure(h, { name: 'create_expense', args: { groupId, expenseId: id, expense: mcpExpense({ paidBy: payer, people: [payer] }) }, headers: alice })
      expect(again).toEqual({ code: 'CONFLICT', message: 'Expense ID already exists. Read it before retrying; use a new ID only for a distinct expense.', outcomeUnknown: false, recovery: 'read_current_revision' })
    }
    const count = await h.withDb((db) => db.select().from(expenses).where(eq(expenses.id, id)))
    expect(count).toHaveLength(1)
  })

  it('records the authenticated actor and key, whoever paid', async () => {
    const id = newExpenseId()
    await checked('create_expense', { groupId: 'g1', expenseId: id, expense: expense({ paidBy: 'pb', title: 'Taxi' }) })
    const [event] = await h.withDb((db) => db.select().from(activities).where(eq(activities.expenseId, id)))
    expect(event).toMatchObject({ type: 'create_expense', actorUserId: 'alice', actorName: 'Alice', source: 'agent', participantId: null, agentKeyId: aliceKeyId })
    const read = await checked('get_expense', { groupId: 'g1', expenseId: id })
    expect((read['expense'] as { attribution: unknown }).attribution).toMatchObject({ createdBy: { userId: 'alice', name: 'Alice', source: 'agent' }, updatedBy: null })
    expect((read['expense'] as { paidBy: unknown }).paidBy).toEqual({ id: 'pb', name: 'Bob', groupId: 'g1' })
  })

  it('accepts several payers, with paidBy as the largest payer', async () => {
    const id = newExpenseId()
    await checked('create_expense', {
      groupId: 'g1',
      expenseId: id,
      expense: expense({ paidBy: null, payers: [{ participant: 'pa', amount: '10' }, { participant: 'pb', amount: '20' }], title: 'Groceries' }),
    })
    const read = (await checked('get_expense', { groupId: 'g1', expenseId: id }))['expense'] as { paidById: string; payers: unknown }
    expect(read.paidById).toBe('pb')
    expect(read.payers).toEqual([
      { participantId: 'pa', name: 'Alice', amount: '10.00' },
      { participantId: 'pb', name: 'Bob', amount: '20.00' },
    ])
    for (const bad of [
      { paidBy: 'pa', payers: [{ participant: 'pa', amount: '30' }] },
      { paidBy: null },
      { paidBy: null, payers: [{ participant: 'pa', amount: '10' }] },
    ]) {
      const refused = await failure(h, { name: 'create_expense', args: { groupId: 'g1', expense: expense(bad) }, headers: alice })
      expect(refused.code).toBe('BAD_REQUEST')
    }
  })

  it('refuses invalid money, dates, splits, people and unknown keys without writing', async () => {
    const { groupId, a, headers, expense: draft } = await household('invalid')
    const written = async () => (await h.withDb((db) => db.select().from(expenses).where(eq(expenses.groupId, groupId)))).length
    for (const bad of [
      { ...draft(), amount: 10 },
      draft({ amount: '12.345' }),
      draft({ amount: ' 1' }),
      draft({ amount: '1e3' }),
      draft({ amount: '0' }),
      draft({ amount: '10000000.01' }),
      draft({ currencyCode: 'JPY', amount: '10.1' }),
      draft({ expenseDate: 'not-a-date' }),
      draft({ expenseDate: '2026-02-29' }),
      draft({ title: 'x' }),
      draft({ splitMode: 'BY_PERCENTAGE', paidFor: [{ participant: a, shares: '50' }] }),
      draft({ splitMode: 'BY_AMOUNT', paidFor: [{ participant: a, shares: '10' }] }),
      draft({ paidFor: [{ participant: a, shares: '1' }, { participant: a, shares: '1' }] }),
      // A participant of another group.
      draft({ paidBy: 'qa' }),
      { ...draft(), originalAmount: '5' },
      draft({ documents: [{ id: 'd', url: 'https://x.example/r.png', width: 1, height: 1 }] }),
    ]) {
      const refused = await failure(h, { name: 'create_expense', args: { groupId, expense: bad }, headers })
      expect(['BAD_REQUEST', 'VALIDATION']).toContain(refused.code)
      expect(refused.outcomeUnknown).toBe(false)
    }
    const extra = await failure(h, { name: 'create_expense', args: { groupId, expense: draft(), participantId: a }, headers })
    expect(extra.code).toBe('VALIDATION')
    expect(await written()).toBe(0)
  })

  it('refuses a group outside the caller’s memberships as Forbidden, with a certain outcome', async () => {
    const denied = await failure(h, { name: 'create_expense', args: { groupId: 'g3', expense: mcpExpense({ paidBy: 'rb', people: ['rb'] }) }, headers: alice })
    expect(denied).toEqual({ code: 'FORBIDDEN', message: GROUP_DENIED, outcomeUnknown: false, recovery: 'correct_arguments' })
    const people = await failure(h, { name: 'create_expense', args: { groupId: 'g1', people: [], expense: expense() }, headers: alice })
    expect(people.code).toBe('VALIDATION')
    const none = await failure(h, { name: 'create_expense', args: { expense: expense() }, headers: alice })
    expect(none.message).toBe('Supply groupId for a group expense, or people for an ungrouped expense.')
  })

  it('edits only the given fields, checks the revision, and skips no-op revisions', async () => {
    const id = newExpenseId()
    await checked('create_expense', { groupId: 'g1', expenseId: id, expense: expense({ vendor: 'Nopa', notes: '3 x 10 = 30' }) })
    const changed = await checked('update_expense', { groupId: 'g1', expenseId: id, expectedRevision: 1, changes: { amount: '45', notes: 'Includes tip' } })
    expect(changed).toEqual({ expenseId: id, revision: 2, amount: '45.00', currencyCode: 'USD', uploads: [], uploadError: null })
    const read = (await checked('get_expense', { groupId: 'g1', expenseId: id }))['expense'] as Record<string, unknown>
    expect(read).toMatchObject({ title: 'Dinner', vendor: 'Nopa', notes: 'Includes tip', amount: '45.00', revision: 2, paidById: 'pa', splitMode: 'EVENLY' })
    expect(read['attribution']).toMatchObject({ updatedBy: { userId: 'alice', source: 'agent' } })
    const stale = await failure(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id, expectedRevision: 1, changes: { title: 'Lunch' } }, headers: alice })
    expect(stale).toMatchObject({ code: 'CONFLICT', recovery: 'read_current_revision', outcomeUnknown: false })
    const noop = await checked('update_expense', { groupId: 'g1', expenseId: id, expectedRevision: 2 })
    expect(noop['revision']).toBe(2)
    const missing = await failure(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id, changes: {} }, headers: alice })
    expect(missing.code).toBe('VALIDATION')
    const cleared = await checked('update_expense', { groupId: 'g1', expenseId: id, expectedRevision: 2, changes: { vendor: null } })
    expect(cleared['revision']).toBe(3)
    expect(((await checked('get_expense', { groupId: 'g1', expenseId: id }))['expense'] as { vendor: unknown }).vendor).toBeNull()
  })

  it('keeps exact BY_AMOUNT shares through a partial edit, and needs payers again for a multi-payer amount change', async () => {
    const { groupId, a, b, headers, expense: draft } = await household('byamount')
    const exact = newExpenseId()
    await checked('create_expense', { groupId, expenseId: exact, expense: draft({ splitMode: 'BY_AMOUNT', amount: '10.50', paidFor: [{ participant: a, shares: '4.25' }, { participant: b, shares: '6.25' }] }) }, headers)
    await checked('update_expense', { groupId, expenseId: exact, expectedRevision: 1, changes: { title: 'Snacks' } }, headers)
    const read = (await checked('get_expense', { groupId, expenseId: exact }, headers))['expense'] as { paidFor: unknown }
    expect(read.paidFor).toEqual([
      { expenseId: exact, participantId: a, shares: '4.25' },
      { expenseId: exact, participantId: b, shares: '6.25' },
    ])
    const shared = newExpenseId()
    await checked('create_expense', { groupId, expenseId: shared, expense: draft({ paidBy: null, payers: [{ participant: a, amount: '10' }, { participant: b, amount: '20' }] }) }, headers)
    const multi = await failure(h, { name: 'update_expense', args: { groupId, expenseId: shared, expectedRevision: 1, changes: { amount: '40' } }, headers })
    expect(multi.code).toBe('BAD_REQUEST')
    const fixed = await checked('update_expense', { groupId, expenseId: shared, expectedRevision: 1, changes: { amount: '40', payers: [{ participant: a, amount: '15' }, { participant: b, amount: '25' }] } }, headers)
    expect(fixed['revision']).toBe(2)
  })

  it('lists with filters before offset pagination, newest expense date first', async () => {
    const { groupId, a, b, c, headers, expense: draft } = await household('filters', { slug: 'lists' })
    const [dinner, rent, payback] = [newExpenseId(), newExpenseId(), newExpenseId()]
    await checked('create_expense', { groupId, expenseId: dinner, expense: draft() }, headers)
    await checked('create_expense', { groupId, expenseId: rent, expense: draft({ title: 'Rent', expenseDate: '2026-10-01', vendor: 'Landlord', category: 18 }) }, headers)
    await checked('create_expense', { groupId, expenseId: payback, expense: draft({ title: 'Payback', expenseDate: '2026-11-03', isReimbursement: true, paidBy: b, paidFor: [{ participant: a, shares: '1' }] }) }, headers)
    const all = await checked('list_expenses', { groupId, limit: 100 }, headers)
    expect((all['expenses'] as { id: string }[]).map((e) => e.id)).toEqual([payback, dinner, rent])
    expect((all['expenses'] as { expenseDate: string }[])[0]?.expenseDate).toBe('2026-11-03T00:00:00.000Z')
    const page = await checked('list_expenses', { groupId, limit: 2 }, headers)
    expect(page).toMatchObject({ hasMore: true, nextCursor: 2 })
    const filtered = async (args: object) => ((await checked('list_expenses', { groupId, limit: 100, ...args }, headers))['expenses'] as { id: string }[]).map((e) => e.id)
    expect(await filtered({ isReimbursement: true })).toEqual([payback])
    expect(await filtered({ vendor: ' landlord ' })).toEqual([rent])
    expect(await filtered({ filter: 'LANDLORD' })).toEqual([rent])
    expect(await filtered({ filter: 'ent' })).toEqual([rent])
    expect(await filtered({ categoryId: 18 })).toEqual([rent])
    expect(await filtered({ from: '2026-10-01', to: '2026-10-01' })).toEqual([rent])
    expect(await filtered({ paidById: b, from: '2026-11-02' })).toEqual([payback])
    expect(await filtered({ participantId: c })).toEqual([dinner, rent])
    expect(await filtered({ currencyCode: 'JPY' })).toEqual([])
    // A slug in any case names the group, and the answers carry its ID.
    expect(await filtered({ groupId: 'LISTS', isReimbursement: true })).toEqual([payback])
    expect(((await checked('get_group', { groupId: 'Lists' }, headers))['group'] as { id: string }).id).toBe(groupId)
    expect(((await checked('list_activity', { groupId: 'lists', limit: 1 }, headers))['activities'] as { groupId: string }[])[0]?.groupId).toBe(groupId)
    const reimbursement = (await checked('list_expenses', { groupId, filter: 'Payback' }, headers))['expenses'] as Record<string, unknown>[]
    expect(reimbursement[0]).toMatchObject({ isReimbursement: true, paidBy: { id: b, name: `Name ${b}` }, paidFor: [{ participant: { id: a, name: 'Lena' }, shares: '1' }], category: { id: 0 } })
  })

  it('refuses bad list bounds and history selections before reading', async () => {
    for (const args of [{ limit: 0 }, { from: '2026-09-31' }, { from: '2026-02-29' }, { to: '2026-11-01T00:00:00Z' }, { from: '2026-11-02', to: '2026-11-01' }]) {
      const refused = await failure(h, { name: 'list_expenses', args: { groupId: 'g1', ...args }, headers: alice })
      expect(refused.code).toBe('VALIDATION')
    }
    const history = await failure(h, { name: 'list_expenses', args: { groupId: 'g1', asOf: '2026-11-01T00:00:00Z', atActivityId: 'a1' }, headers: alice })
    expect(history.code).toBe('BAD_REQUEST')
    const denied = await failure(h, { name: 'list_expenses', args: { groupId: 'g3' }, headers: alice })
    expect(denied.code).toBe('FORBIDDEN')
    // A wrong group never shows another group’s expense.
    const id = newExpenseId()
    await checked('create_expense', { groupId: 'g1', expenseId: id, expense: expense() })
    const other = await failure(h, { name: 'get_expense', args: { groupId: 'g2', expenseId: id }, headers: alice })
    expect(other).toMatchObject({ code: 'NOT_FOUND', message: 'Expense not found' })
  })

  it('soft-deletes with the current revision and keeps the history', async () => {
    const id = newExpenseId()
    await checked('create_expense', { groupId: 'g1', expenseId: id, expense: expense({ title: 'Taxi' }) })
    const stale = await failure(h, { name: 'delete_expense', args: { groupId: 'g1', expenseId: id, expectedRevision: 0 }, headers: alice })
    expect(stale.code).toBe('CONFLICT')
    const deleted = await checked('delete_expense', { groupId: 'g1', expenseId: id, expectedRevision: 1 })
    expect(deleted).toEqual({ expenseId: id, revision: 2, deleted: true })
    expect((await failure(h, { name: 'get_expense', args: { groupId: 'g1', expenseId: id }, headers: alice })).code).toBe('NOT_FOUND')
    expect((await failure(h, { name: 'delete_expense', args: { groupId: 'g1', expenseId: id, expectedRevision: 2 }, headers: alice })).code).toBe('NOT_FOUND')
    const listed = (await checked('list_expenses', { groupId: 'g1', limit: 100 }))['expenses'] as { id: string }[]
    expect(listed.map((e) => e.id)).not.toContain(id)
    const events = await h.withDb((db) => db.select({ revision: activities.expenseRevision }).from(activities).where(eq(activities.expenseId, id)))
    expect(events.map((e) => e.revision).sort()).toEqual([1, 2])
  })

  it('lists the participants referenced by any expense, deleted ones included', async () => {
    const { groupId, a, b, c, headers, expense: draft } = await household('referenced')
    const referenced = async () => (await checked('get_group', { groupId }, headers))['participantsWithExpenses']
    expect(await referenced()).toEqual([])
    await checked('create_expense', { groupId, expenseId: newExpenseId(), expense: draft({ people: [a, b] }) }, headers)
    expect(await referenced()).toEqual([a, b])
    // Only a deleted expense names c.
    const gone = newExpenseId()
    await checked('create_expense', { groupId, expenseId: gone, expense: draft({ paidBy: a, paidFor: [{ participant: c, shares: '1' }] }) }, headers)
    await checked('delete_expense', { groupId, expenseId: gone, expectedRevision: 1 }, headers)
    expect(await referenced()).toEqual([a, b, c])
  })

  it('applies a membership removal to every key at the next request', async () => {
    const { owner, groupId, headers } = await household('removal')
    const second = { authorization: `Bearer ${await h.apiKey(owner)}` }
    for (const key of [headers, second]) expect(((await checked('get_group', { groupId }, key))['group'] as { id: string }).id).toBe(groupId)
    await h.withDb((db) => db.update(memberships).set({ active: false }).where(eq(memberships.userId, owner)))
    for (const key of [headers, second]) expect((await failure(h, { name: 'get_group', args: { groupId }, headers: key })).code).toBe('FORBIDDEN')
  })

  it('retries a write after a serialization failure, as the RPC path does', async () => {
    const { groupId, headers, expense: draft } = await household('retry')
    const id = id21('r', 1)
    // The first insert of this expense fails as a concurrent SERIALIZABLE write would. A sequence is not rolled back, so only the first attempt fails.
    await h.withDb((db) =>
      db.execute(sql`
        CREATE SEQUENCE retry_attempts;
        CREATE FUNCTION fail_first_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF nextval('retry_attempts') = 1 THEN RAISE EXCEPTION 'could not serialize access' USING ERRCODE = 'serialization_failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER fail_first_attempt BEFORE INSERT ON expenses FOR EACH ROW WHEN (NEW.id = 'r00000000000000000001') EXECUTE FUNCTION fail_first_attempt();`),
    )
    try {
      const created = await checked('create_expense', { groupId, expenseId: id, expense: draft() }, headers)
      expect(created).toMatchObject({ groupId, expenseId: id, revision: 1 })
      const attempts = await h.withDb((db) => db.execute<{ n: string }>(sql`SELECT last_value::text AS n FROM retry_attempts`))
      expect(attempts.rows[0]?.n).toBe('2')
    } finally {
      await h.withDb((db) => db.execute(sql`DROP TRIGGER fail_first_attempt ON expenses; DROP FUNCTION fail_first_attempt(); DROP SEQUENCE retry_attempts;`))
    }
  })

  it('splits a negative amount by amount, as a refund that the group shares (P-BAL-93, P-MONEY-52)', async () => {
    const id = newExpenseId()
    const refund = expense({ title: 'Refund', amount: '-30', splitMode: 'BY_AMOUNT', paidFor: [{ participant: 'pa', shares: '-10' }, { participant: 'pb', shares: '-20' }] })
    const created = await checked('create_expense', { groupId: 'g1', expenseId: id, expense: refund })
    expect(created).toMatchObject({ revision: 1, amount: '-30.00' })
    const shares = [
      { expenseId: id, participantId: 'pa', shares: '-10.00' },
      { expenseId: id, participantId: 'pb', shares: '-20.00' },
    ]
    expect(((await checked('get_expense', { groupId: 'g1', expenseId: id }))['expense'] as { paidFor: unknown }).paidFor).toEqual(shares)
    // The saved revision reads back the same split.
    expect(((await checked('get_expense', { groupId: 'g1', expenseId: id, revision: 1 }))['expense'] as { paidFor: unknown }).paidFor).toEqual(shares)
  })

  // A database rule answers the caller; as an outage, the agent would read the outcome as unknown and retry.
  it('answers a write that a database CHECK refuses as BAD_REQUEST, without database detail', async () => {
    await h.withDb((db) => db.execute(sql`ALTER TABLE expenses ADD CONSTRAINT refused_for_test CHECK (title <> 'Refused by the database') NOT VALID`))
    try {
      const refused = await failure(h, { name: 'create_expense', args: { groupId: 'g1', expense: expense({ title: 'Refused by the database' }) }, headers: alice })
      expect(refused).toEqual({
        code: 'BAD_REQUEST',
        message: 'The change breaks a rule of the ledger. Check the amounts, the splits and the other fields.',
        outcomeUnknown: false,
        recovery: 'correct_arguments',
      })
    } finally {
      await h.withDb((db) => db.execute(sql`ALTER TABLE expenses DROP CONSTRAINT refused_for_test`))
    }
  })
})

describe('API keys on the endpoint', () => {
  const list = (headers: Record<string, string>) =>
    h.fetch(
      new Request(MCP_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      }),
    )
  it('accepts the raw key in X-API-Key or Bearer, or both when equal', async () => {
    const key = alice['x-api-key'] ?? ''
    expect((await list({ 'x-api-key': key })).status).toBe(200)
    expect((await list({ 'X-Api-Key': key })).status).toBe(200)
    expect((await list({ authorization: `Bearer ${key}` })).status).toBe(200)
    expect((await list({ 'x-api-key': key, authorization: `Bearer ${key}` })).status).toBe(200)
  })

  it('refuses conflicting, malformed, unknown, revoked and unverified credentials with one challenge format', async () => {
    const key = alice['x-api-key'] ?? ''
    const carol = await h.apiKey('carol')
    await h.account('revoked')
    const revoked = await h.apiKey('revoked')
    expect((await list({ 'x-api-key': revoked })).status).toBe(200)
    await h.withDb((db) => db.execute(sql`DELETE FROM apikey WHERE reference_id = 'revoked'`))
    for (const headers of [
      {},
      { 'x-api-key': key, authorization: `Bearer ${bob['authorization']?.slice(7)}` },
      { 'x-api-key': key, authorization: `Basic ${key}` },
      { 'x-api-key': 'short' },
      { 'x-api-key': `agentsplit_${'x'.repeat(40)}` },
      { 'x-api-key': carol },
      { 'x-api-key': revoked },
    ]) {
      const r = await list(headers)
      expect(r.status).toBe(401)
      expect(r.headers.get('www-authenticate')).toBe(
        `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/mcp", scope="agentsplit:read agentsplit:write offline_access"`,
      )
      expect(await r.json()).toEqual({ error: 'Authentication required' })
      expect(r.headers.get('cache-control')).toBe('no-store')
    }
  })
})

describe('rate limit', () => {
  it('takes 120 requests a minute per user, refilled two a second, at a fixed clock', async () => {
    const at = new Date('2026-11-05T12:00:00.000Z')
    const take = (userId: string, time: Date) => h.withDb((db) => takeMcpRequest(db, { userId, at: time }))
    for (let i = 0; i < LIMITS.mcpRequestsPerMinute; i++) expect(await take('erin', at)).toBe(0)
    expect(await take('erin', at)).toBe(1)
    const half = new Date(at.getTime() + 500)
    expect(await take('erin', half)).toBe(0)
    expect(await take('erin', half)).toBe(1)
    expect(await take('frank', at)).toBe(0)
  })

  it('shares one bucket per user across keys and answers 429 with Retry-After at the endpoint', async () => {
    await h.account('dave')
    const daveKey = { 'x-api-key': await h.apiKey('dave') }
    const otherKey = { 'x-api-key': await h.apiKey('dave') }
    // The two keys take turns, so neither reaches its own limit of 120 a minute. The bucket refills
    // two requests a second while this runs, so allow a few more than its size.
    let allowed = 0
    while (allowed < LIMITS.mcpRequestsPerMinute + 10 && (await rpc(h, { method: 'tools/list', headers: allowed % 2 ? otherKey : daveKey })).status === 200) allowed++
    expect(allowed).toBeGreaterThanOrEqual(LIMITS.mcpRequestsPerMinute)
    expect(allowed).toBeLessThan(LIMITS.mcpRequestsPerMinute + 10)
    for (const headers of [daveKey, otherKey]) {
      const limited = await rpc(h, { method: 'tools/call', params: { name: 'list_groups', arguments: {} }, headers })
      expect(limited.status).toBe(429)
      expect(limited.body).toEqual({ error: 'MCP request rate exceeded' })
      expect(limited.headers.get('retry-after')).toBe('1')
      expect(limited.headers.get('cache-control')).toBe('no-store')
    }
    // Another user is not affected.
    expect((await rpc(h, { method: 'tools/list', headers: alice })).status).toBe(200)
  })

  it('does not spend a bucket on unauthenticated requests', async () => {
    const buckets = () => h.withDb(async (db) => (await db.select().from(mcpRateLimits)).length)
    const before = await buckets()
    expect((await rpc(h, { method: 'tools/list' })).status).toBe(401)
    expect(await buckets()).toBe(before)
  })
})
