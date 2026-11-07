// The MCP endpoint and its first seven tools, over HTTP in process, against a
// real database. Parity items are named in docs/v2/parity/mcp.md.
import { Schema } from 'effect'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activities, expenses, memberships } from '../../db/schema/app'
import { eq } from 'drizzle-orm'
import { MCP_TOOLS } from '~/server/mcp/tools'
import { takeMcpRequest } from '~/server/rate-limit'
import current from './fixtures/current-mcp-tools.json'
import { BASE, callTool, failure, MCP_URL, ok, rpc, startHarness, type Harness } from './mcp-harness'

let h: Harness
let alice: Record<string, string>
let bob: Record<string, string>

const id21 = (n: number) => `e${String(n).padStart(20, '0')}`

beforeAll(async () => {
  h = await startHarness()
  await h.account('alice', { name: 'Alice' })
  await h.account('bob', { name: 'Bob' })
  await h.account('carol', { name: 'Carol', verified: false })
  await h.group({ id: 'g1', name: 'Home', slug: 'home', people: ['pa', 'pb', 'pc'], members: [['alice', 'pa', 'admin'], ['bob', 'pb', 'member']] })
  await h.group({ id: 'g2', name: 'Trip', people: ['qa'], members: [['alice', 'qa', 'admin']] })
  await h.group({ id: 'g3', name: 'Bob only', people: ['rb'], members: [['bob', 'rb', 'admin']] })
  await h.privateContext({ owner: 'alice', expenseId: 'private-dinner' })
  alice = { 'x-api-key': await h.apiKey('alice') }
  bob = { authorization: `Bearer ${await h.apiKey('bob')}` }
})
afterAll(() => h.close())

const tool = (name: string) => {
  const found = MCP_TOOLS.find((t) => t.name === name)
  if (!found) throw new Error(name)
  return found
}
/** Every result must decode with the tool's advertised output schema. */
const checked = async (name: string, args: object, headers = alice) => {
  const result = await ok(h, { name, args, headers })
  Schema.decodeUnknownSync(tool(name).output as Schema.Codec<unknown>)(result)
  return result
}

const expense = (over: Record<string, unknown> = {}) => ({
  title: 'Dinner',
  expenseDate: '2026-11-01',
  amount: '30',
  currencyCode: 'USD',
  paidBy: 'pa',
  paidFor: [
    { participant: 'pa', shares: '1' },
    { participant: 'pb', shares: '1' },
    { participant: 'pc', shares: '1' },
  ],
  isReimbursement: false,
  ...over,
})

describe('protocol', () => {
  it('initializes legacy 2025 clients with the instructions and server info', async () => {
    for (const protocolVersion of ['2025-03-26', '2025-06-18']) {
      const r = await rpc(h, { method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'codex', version: '1' } }, headers: alice })
      expect(r.status).toBe(200)
      const result = (r.body as { result: { serverInfo: unknown; instructions: string; capabilities: { tools?: unknown } } }).result
      expect(result.serverInfo).toEqual({ name: 'agentsplit', version: '0.4.0' })
      expect(result.capabilities.tools).toBeDefined()
      expect(result.instructions).toContain('decimal strings')
      expect(result.instructions).toContain('global')
      expect(result.instructions).not.toContain('minor units')
      // The v2 recording rules (docs/v2/PLAN.md).
      expect(result.instructions).toContain('including the payer’s own share')
      expect(result.instructions).toContain('Include the payer in paidFor with their share, unless the payer paid only for other people')
      expect(result.instructions).toContain('Put the full calculation in notes')
      expect(result.instructions).toContain('Keep the title short')
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
    const r = await h.mcp(new Request(MCP_URL, { method: 'POST', headers, body }))
    expect(r.status).toBe(200)
    const reply = (await r.json()) as { result: { tools?: unknown[]; isError?: boolean } }
    if (name) expect(reply.result.isError).not.toBe(true)
    else expect(reply.result.tools).toHaveLength(MCP_TOOLS.length)
    const mismatch = await h.mcp(new Request(MCP_URL, { method: 'POST', headers: { ...headers, 'Mcp-Method': 'wrong-method' }, body }))
    expect(mismatch.status).toBe(400)
    expect(((await mismatch.json()) as { error: { code: number } }).error.code).toBe(-32020)
  })

  it('requires MCP-Protocol-Version on modern requests, with the request ID', async () => {
    const body = { ...modern('tools/list'), id: 'modern-check' }
    const r = await h.mcp(
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
      const r = await h.mcp(new Request(MCP_URL, { method: 'POST', headers: { ...headers, ...extra }, body }))
      expect(r.status).toBe(403)
      expect(await r.json()).toEqual({ error: 'Origin or host is not allowed' })
      expect(r.headers.get('cache-control')).toBe('no-store')
    }
    const same = await h.mcp(new Request(MCP_URL, { method: 'POST', headers: { ...headers, origin: BASE }, body }))
    expect(same.status).toBe(200)
  })

  it('answers GET and DELETE with the SDK’s stateless 405', async () => {
    for (const method of ['GET', 'DELETE']) {
      const r = await h.mcp(new Request(MCP_URL, { method, headers: alice }))
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
      const failed = r.result?.isError === true || (r.body as { error?: unknown }).error !== undefined
      expect(failed).toBe(true)
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

  it('describes the recording rules on create and update', () => {
    for (const name of ['create_expense', 'update_expense']) {
      const schema = JSON.stringify(tool(name).inputSchema)
      expect(schema).toContain('including the payer’s own share')
      expect(schema).toContain('Include the payer with their share, unless the payer paid only for other people')
      expect(schema).toContain('so that a person can recalculate every number')
      expect(tool(name).description).toContain('Keep the title short')
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
      revision: 0,
      _count: { participants: 3 },
    })
  })

  it('fails the whole call when one requested group is not the caller’s', async () => {
    expect((await checked('list_groups', { groupIds: ['g1'] }))['groups']).toHaveLength(1)
    const denied = await failure(h, { name: 'list_groups', args: { groupIds: ['g1', 'g3'] }, headers: alice })
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
      expect(denied).toMatchObject({ code: 'FORBIDDEN', message: 'Group not found, or you are not a member', outcomeUnknown: false })
    }
  })
})

describe('expense writes and reads', () => {
  it('creates with a stable ID, and a reused ID is a Conflict in any group', async () => {
    const created = await checked('create_expense', { groupId: 'g1', expenseId: id21(1), expense: expense({ vendor: 'Nopa', notes: '3 x 10 = 30' }) })
    expect(created).toEqual({ groupId: 'g1', expenseId: id21(1), revision: 1, amount: '30.00', currencyCode: 'USD', uploads: [], uploadError: null })
    for (const groupId of ['g1', 'g2']) {
      const again = await failure(h, { name: 'create_expense', args: { groupId, expenseId: id21(1), expense: expense({ paidBy: groupId === 'g2' ? 'qa' : 'pa', paidFor: [{ participant: groupId === 'g2' ? 'qa' : 'pa', shares: '1' }] }) }, headers: alice })
      expect(again).toEqual({ code: 'CONFLICT', message: 'Expense ID already exists. Read it before retrying; use a new ID only for a distinct expense.', outcomeUnknown: false, recovery: 'read_current_revision' })
    }
    const count = await h.withDb((db) => db.select().from(expenses).where(eq(expenses.id, id21(1))))
    expect(count).toHaveLength(1)
  })

  it('records the authenticated actor and key, whoever paid', async () => {
    await checked('create_expense', { groupId: 'g1', expenseId: id21(2), expense: expense({ paidBy: 'pb', title: 'Taxi' }) })
    const [event] = await h.withDb((db) => db.select().from(activities).where(eq(activities.expenseId, id21(2))))
    expect(event).toMatchObject({ type: 'create_expense', actorUserId: 'alice', actorName: 'Alice', source: 'agent', participantId: null })
    expect(event?.agentKeyId).toBeTruthy()
    const read = await checked('get_expense', { groupId: 'g1', expenseId: id21(2) })
    expect((read['expense'] as { attribution: unknown }).attribution).toMatchObject({ createdBy: { userId: 'alice', name: 'Alice', source: 'agent' }, updatedBy: null })
    expect((read['expense'] as { paidBy: unknown }).paidBy).toEqual({ id: 'pb', name: 'Bob', groupId: 'g1' })
  })

  it('accepts several payers, with paidBy as the largest payer', async () => {
    await checked('create_expense', {
      groupId: 'g1',
      expenseId: id21(3),
      expense: expense({ paidBy: undefined, payers: [{ participant: 'pa', amount: '10' }, { participant: 'pb', amount: '20' }], title: 'Groceries' }),
    })
    const read = (await checked('get_expense', { groupId: 'g1', expenseId: id21(3) }))['expense'] as { paidById: string; payers: unknown }
    expect(read.paidById).toBe('pb')
    expect(read.payers).toEqual([
      { participantId: 'pa', name: 'Alice', amount: '10.00' },
      { participantId: 'pb', name: 'Bob', amount: '20.00' },
    ])
    for (const bad of [
      { paidBy: 'pa', payers: [{ participant: 'pa', amount: '30' }] },
      { paidBy: undefined },
      { paidBy: undefined, payers: [{ participant: 'pa', amount: '10' }] },
    ]) {
      const refused = await failure(h, { name: 'create_expense', args: { groupId: 'g1', expense: expense(bad) }, headers: alice })
      expect(refused.code).toBe('BAD_REQUEST')
    }
  })

  it('refuses invalid money, dates, splits, people and unknown keys without writing', async () => {
    const before = (await h.withDb((db) => db.select().from(expenses))).length
    for (const bad of [
      expense({ amount: 10 }),
      expense({ amount: '12.345' }),
      expense({ amount: ' 1' }),
      expense({ amount: '1e3' }),
      expense({ amount: '0' }),
      expense({ amount: '10000000.01' }),
      expense({ currencyCode: 'JPY', amount: '10.1' }),
      expense({ expenseDate: 'not-a-date' }),
      expense({ expenseDate: '2026-02-29' }),
      expense({ title: 'x' }),
      expense({ splitMode: 'BY_PERCENTAGE', paidFor: [{ participant: 'pa', shares: '50' }] }),
      expense({ splitMode: 'BY_AMOUNT', paidFor: [{ participant: 'pa', shares: '10' }] }),
      expense({ paidFor: [{ participant: 'pa', shares: '1' }, { participant: 'pa', shares: '1' }] }),
      expense({ paidBy: 'qa' }),
      expense({ originalAmount: '5' }),
      expense({ documents: [{ id: 'd', url: 'https://x.example/r.png', width: 1, height: 1 }] }),
    ]) {
      const refused = await failure(h, { name: 'create_expense', args: { groupId: 'g1', expense: bad }, headers: alice })
      expect(['BAD_REQUEST', 'VALIDATION']).toContain(refused.code)
      expect(refused.outcomeUnknown).toBe(false)
    }
    const extra = await failure(h, { name: 'create_expense', args: { groupId: 'g1', expense: expense(), participantId: 'pa' }, headers: alice })
    expect(extra.code).toBe('VALIDATION')
    expect((await h.withDb((db) => db.select().from(expenses))).length).toBe(before)
  })

  it('refuses a group outside the caller’s memberships as Forbidden, with a certain outcome', async () => {
    const denied = await failure(h, { name: 'create_expense', args: { groupId: 'g3', expense: expense({ paidBy: 'rb', paidFor: [{ participant: 'rb', shares: '1' }] }) }, headers: alice })
    expect(denied).toEqual({ code: 'FORBIDDEN', message: 'Group not found, or you are not a member', outcomeUnknown: false, recovery: 'correct_arguments' })
    const people = await failure(h, { name: 'create_expense', args: { groupId: 'g1', people: [], expense: expense() }, headers: alice })
    expect(people.code).toBe('VALIDATION')
    const none = await failure(h, { name: 'create_expense', args: { expense: expense() }, headers: alice })
    expect(none.message).toBe('Supply groupId for a group expense, or people for an ungrouped expense.')
  })

  it('edits only the given fields, checks the revision, and skips no-op revisions', async () => {
    const changed = await checked('update_expense', { groupId: 'g1', expenseId: id21(1), expectedRevision: 1, changes: { amount: '45', notes: 'Includes tip' } })
    expect(changed).toEqual({ expenseId: id21(1), revision: 2, amount: '45.00', currencyCode: 'USD', uploads: [], uploadError: null })
    const read = (await checked('get_expense', { groupId: 'g1', expenseId: id21(1) }))['expense'] as Record<string, unknown>
    expect(read).toMatchObject({ title: 'Dinner', vendor: 'Nopa', notes: 'Includes tip', amount: '45.00', revision: 2, paidById: 'pa', splitMode: 'EVENLY' })
    expect(read['attribution']).toMatchObject({ updatedBy: { userId: 'alice', source: 'agent' } })
    const stale = await failure(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id21(1), expectedRevision: 1, changes: { title: 'Lunch' } }, headers: alice })
    expect(stale).toMatchObject({ code: 'CONFLICT', recovery: 'read_current_revision', outcomeUnknown: false })
    const noop = await checked('update_expense', { groupId: 'g1', expenseId: id21(1), expectedRevision: 2 })
    expect(noop['revision']).toBe(2)
    const missing = await failure(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id21(1), changes: {} }, headers: alice })
    expect(missing.code).toBe('VALIDATION')
    const cleared = await checked('update_expense', { groupId: 'g1', expenseId: id21(1), expectedRevision: 2, changes: { vendor: null } })
    expect(cleared['revision']).toBe(3)
    expect(((await checked('get_expense', { groupId: 'g1', expenseId: id21(1) }))['expense'] as { vendor: unknown }).vendor).toBeNull()
  })

  it('keeps exact BY_AMOUNT shares through a partial edit, and needs payers again for a multi-payer amount change', async () => {
    await checked('create_expense', {
      groupId: 'g1',
      expenseId: id21(5),
      expense: expense({ splitMode: 'BY_AMOUNT', amount: '10.50', paidFor: [{ participant: 'pa', shares: '4.25' }, { participant: 'pb', shares: '6.25' }] }),
    })
    await checked('update_expense', { groupId: 'g1', expenseId: id21(5), expectedRevision: 1, changes: { title: 'Snacks' } })
    const read = (await checked('get_expense', { groupId: 'g1', expenseId: id21(5) }))['expense'] as { paidFor: unknown }
    expect(read.paidFor).toEqual([
      { expenseId: id21(5), participantId: 'pa', shares: '4.25' },
      { expenseId: id21(5), participantId: 'pb', shares: '6.25' },
    ])
    const multi = await failure(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id21(3), expectedRevision: 1, changes: { amount: '40' } }, headers: alice })
    expect(multi.code).toBe('BAD_REQUEST')
    const fixed = await checked('update_expense', {
      groupId: 'g1',
      expenseId: id21(3),
      expectedRevision: 1,
      changes: { amount: '40', payers: [{ participant: 'pa', amount: '15' }, { participant: 'pb', amount: '25' }] },
    })
    expect(fixed['revision']).toBe(2)
  })

  it('lists with filters before offset pagination, newest expense date first', async () => {
    await checked('create_expense', { groupId: 'g1', expenseId: id21(6), expense: expense({ title: 'Rent', expenseDate: '2026-10-01', vendor: 'Landlord', category: 18 }) })
    await checked('create_expense', { groupId: 'g1', expenseId: id21(7), expense: expense({ title: 'Payback', expenseDate: '2026-11-03', isReimbursement: true, paidBy: 'pb', paidFor: [{ participant: 'pa', shares: '1' }] }) })
    const all = await checked('list_expenses', { groupId: 'g1', limit: 100 })
    const dates = (all['expenses'] as { expenseDate: string }[]).map((e) => e.expenseDate)
    expect(dates).toEqual([...dates].sort().reverse())
    expect(dates[0]).toBe('2026-11-03T00:00:00.000Z')
    const page = await checked('list_expenses', { groupId: 'g1', limit: 2 })
    expect(page).toMatchObject({ hasMore: true, nextCursor: 2 })
    const filtered = async (args: object) => ((await checked('list_expenses', { groupId: 'g1', limit: 100, ...args }))['expenses'] as { id: string }[]).map((e) => e.id)
    expect(await filtered({ isReimbursement: true })).toEqual([id21(7)])
    expect(await filtered({ vendor: ' landlord ' })).toEqual([id21(6)])
    expect(await filtered({ filter: 'LANDLORD' })).toEqual([id21(6)])
    expect(await filtered({ filter: 'ent' })).toEqual([id21(6)])
    expect(await filtered({ categoryId: 18 })).toEqual([id21(6)])
    expect(await filtered({ from: '2026-10-01', to: '2026-10-01' })).toEqual([id21(6)])
    expect(await filtered({ paidById: 'pb', from: '2026-11-02' })).toEqual([id21(7)])
    expect((await filtered({ participantId: 'pc' })).includes(id21(7))).toBe(false)
    expect(await filtered({ currencyCode: 'JPY' })).toEqual([])
    // A slug in any case names the group, and the answers carry its ID.
    expect(await filtered({ groupId: 'HOME', isReimbursement: true })).toEqual([id21(7)])
    expect(((await checked('get_group', { groupId: 'Home' }))['group'] as { id: string }).id).toBe('g1')
    expect(((await checked('list_activity', { groupId: 'home', limit: 1 }))['activities'] as { groupId: string }[])[0]?.groupId).toBe('g1')
    const reimbursement = (await checked('list_expenses', { groupId: 'g1', filter: 'Payback' }))['expenses'] as Record<string, unknown>[]
    expect(reimbursement[0]).toMatchObject({ isReimbursement: true, paidBy: { id: 'pb', name: 'Bob' }, paidFor: [{ participant: { id: 'pa', name: 'Alice' }, shares: '1' }], category: { id: 0 } })
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
    const other = await failure(h, { name: 'get_expense', args: { groupId: 'g2', expenseId: id21(1) }, headers: alice })
    expect(other).toMatchObject({ code: 'NOT_FOUND', message: 'Expense not found' })
  })

  it('soft-deletes with the current revision and keeps the history', async () => {
    const stale = await failure(h, { name: 'delete_expense', args: { groupId: 'g1', expenseId: id21(2), expectedRevision: 0 }, headers: alice })
    expect(stale.code).toBe('CONFLICT')
    const deleted = await checked('delete_expense', { groupId: 'g1', expenseId: id21(2), expectedRevision: 1 })
    expect(deleted).toEqual({ expenseId: id21(2), revision: 2, deleted: true })
    expect((await failure(h, { name: 'get_expense', args: { groupId: 'g1', expenseId: id21(2) }, headers: alice })).code).toBe('NOT_FOUND')
    expect((await failure(h, { name: 'delete_expense', args: { groupId: 'g1', expenseId: id21(2), expectedRevision: 2 }, headers: alice })).code).toBe('NOT_FOUND')
    const listed = (await checked('list_expenses', { groupId: 'g1', limit: 100 }))['expenses'] as { id: string }[]
    expect(listed.map((e) => e.id)).not.toContain(id21(2))
    const events = await h.withDb((db) => db.select({ revision: activities.expenseRevision }).from(activities).where(eq(activities.expenseId, id21(2))))
    expect(events.map((e) => e.revision).sort()).toEqual([1, 2])
  })

  it('lists the participants referenced by any expense, deleted ones included', async () => {
    expect((await checked('get_group', { groupId: 'g1' }))['participantsWithExpenses']).toEqual(['pa', 'pb', 'pc'])
    expect((await checked('get_group', { groupId: 'g2' }))['participantsWithExpenses']).toEqual([])
  })

  it('applies a membership removal to every key at the next request', async () => {
    expect((await checked('get_group', { groupId: 'g1' }, bob))['context']).toBeDefined()
    await h.withDb((db) => db.update(memberships).set({ active: false }).where(eq(memberships.userId, 'bob')))
    expect((await failure(h, { name: 'get_group', args: { groupId: 'g1' }, headers: bob })).code).toBe('FORBIDDEN')
    await h.withDb((db) => db.update(memberships).set({ active: true }).where(eq(memberships.userId, 'bob')))
  })

  it('retries a write after a serialization failure, as the RPC path does', async () => {
    await h.group({ id: 'g-retry', people: ['ta'], members: [['alice', 'ta', 'admin']] })
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
      const created = await checked('create_expense', {
        groupId: 'g-retry',
        expenseId: 'r00000000000000000001',
        expense: expense({ paidBy: 'ta', paidFor: [{ participant: 'ta', shares: '1' }] }),
      })
      expect(created).toMatchObject({ groupId: 'g-retry', expenseId: 'r00000000000000000001', revision: 1 })
      const attempts = await h.withDb((db) => db.execute<{ n: string }>(sql`SELECT last_value::text AS n FROM retry_attempts`))
      expect(attempts.rows[0]?.n).toBe('2')
    } finally {
      await h.withDb((db) => db.execute(sql`DROP TRIGGER fail_first_attempt ON expenses; DROP FUNCTION fail_first_attempt(); DROP SEQUENCE retry_attempts;`))
    }
  })

  // A database rule answers the caller; as an outage, the agent would read the outcome as unknown and retry.
  it('answers a write that a database CHECK refuses as BAD_REQUEST, without database detail', async () => {
    const refund = expense({ amount: '-30', splitMode: 'BY_AMOUNT', paidFor: [{ participant: 'pa', shares: '-10' }, { participant: 'pb', shares: '-20' }] })
    const refused = await failure(h, { name: 'create_expense', args: { groupId: 'g1', expense: refund }, headers: alice })
    expect(refused).toEqual({
      code: 'BAD_REQUEST',
      message: 'The change breaks a rule of the ledger. Check the amounts, the splits and the other fields.',
      outcomeUnknown: false,
      recovery: 'correct_arguments',
    })
  })
})

describe('API keys on the endpoint', () => {
  const list = (headers: Record<string, string>) => h.mcp(new Request(MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' }))
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
    for (const headers of [
      {},
      { 'x-api-key': key, authorization: `Bearer ${bob['authorization']?.slice(7)}` },
      { 'x-api-key': key, authorization: `Basic ${key}` },
      { 'x-api-key': 'short' },
      { 'x-api-key': `agentsplit_${'x'.repeat(40)}` },
      { 'x-api-key': carol },
    ]) {
      const r = await list(headers)
      expect(r.status).toBe(401)
      expect(r.headers.get('www-authenticate')).toBe(
        `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/mcp", scope="agentsplit:read agentsplit:write offline_access"`,
      )
      expect(await r.json()).toEqual({ error: 'Authentication required' })
      expect(r.headers.get('cache-control')).toBe('no-store')
    }
    const revoked = await h.apiKey('alice')
    await h.withDb((db) => db.execute(sql`DELETE FROM apikey WHERE key = (SELECT key FROM apikey ORDER BY created_at DESC LIMIT 1)`))
    expect((await list({ 'x-api-key': revoked })).status).toBe(401)
  })
})

describe('rate limit', () => {
  it('shares one bucket per user across keys, answers 429 with Retry-After, and refills', async () => {
    await h.account('dave')
    const daveKey = { 'x-api-key': await h.apiKey('dave') }
    const otherKey = { 'x-api-key': await h.apiKey('dave') }
    // 120 requests empty the bucket (the endpoint takes one per request; take the rest directly).
    expect((await rpc(h, { method: 'tools/list', headers: daveKey })).status).toBe(200)
    for (let i = 0; i < 119; i++) expect(await h.withDb((db) => takeMcpRequest(db, 'dave'))).toBe(0)
    for (const headers of [daveKey, otherKey]) {
      const limited = await rpc(h, { method: 'tools/call', params: { name: 'list_groups', arguments: {} }, headers })
      expect(limited.status).toBe(429)
      expect(limited.body).toEqual({ error: 'MCP request rate exceeded' })
      expect(limited.headers.get('retry-after')).toBe('1')
      expect(limited.headers.get('cache-control')).toBe('no-store')
    }
    // Another user is not affected.
    expect((await rpc(h, { method: 'tools/list', headers: alice })).status).toBe(200)
    // Half a second refills one request.
    await h.withDb((db) => db.execute(sql`UPDATE mcp_rate_limits SET updated_at = updated_at - interval '500 milliseconds' WHERE user_id = 'dave'`))
    expect((await rpc(h, { method: 'tools/list', headers: daveKey })).status).toBe(200)
    expect((await rpc(h, { method: 'tools/list', headers: daveKey })).status).toBe(429)
  })

  it('does not spend a bucket on unauthenticated requests', async () => {
    const before = await h.withDb((db) => db.execute(sql`SELECT count(*)::int AS n FROM mcp_rate_limits`))
    expect((await rpc(h, { method: 'tools/list' })).status).toBe(401)
    const after = await h.withDb((db) => db.execute(sql`SELECT count(*)::int AS n FROM mcp_rate_limits`))
    expect(after.rows).toEqual(before.rows)
  })
})
