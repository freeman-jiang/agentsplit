// The app's routing that fails silently: the server's half of v1's
// group URLs (src/proxy.ts at bb26b78), the request ID of RPC responses,
// the origin rule, the hourly job and the maintenance switch. A wrong redirect breaks old links,
// a missing ID leaves a quoted error reference without a log line, and a broken
// switch lets writes in during a cutover.
import { count, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { expenses, groups } from '../../db/schema/app'
import { createExpense } from '~/server/ledger'
import { draft } from '../kit/drafts'
import { principal } from '../kit/people'
import { BASE, startHarness, type Harness } from './harness'

const SLUGGED = 'AbCdEfGhIjKlMnOpQrS_1'
const UNSLUGGED = 'ZyXwVuTsRqPoNmLkJiH_2'

let h: Harness

beforeAll(async () => {
  h = await startHarness()
  await h.withDb((db) =>
    db.insert(groups).values([
      { id: SLUGGED, kind: 'named', slug: 'household', name: 'Household', defaultCurrency: 'USD' },
      { id: UNSLUGGED, kind: 'named', slug: null, name: 'Trip', defaultCurrency: 'USD' },
    ]),
  )
})
afterAll(() => h.close())

const get = (path: string, method = 'GET') => h.fetch(new Request(`${BASE}${path}`, { method, redirect: 'manual' }))

describe('group URLs', () => {
  it('moves /groups/<id>/… of a group with a slug to /<slug>/… with a private, uncached 307, keeping the query', async () => {
    const response = await get(`/groups/${SLUGGED}/balances?sort=updated`)
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('/household/balances?sort=updated')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect((await get(`/groups/${SLUGGED}`)).headers.get('location')).toBe('/household')
  })

  it('keeps /groups/<id>/… of a group without a slug, and opens /groups/<id> on its expenses', async () => {
    const page = await get(`/groups/${UNSLUGGED}/expenses`)
    expect(page.status).toBe(200)
    expect(await page.text()).toBe('SPA page')
    const root = await get(`/groups/${UNSLUGGED}`)
    expect(root.status).toBe(307)
    expect(root.headers.get('location')).toBe(`/groups/${UNSLUGGED}/expenses`)
  })

  it('moves v2’s first URLs, /<id>/…, to the group’s URL', async () => {
    expect((await get(`/${UNSLUGGED}/stats`)).headers.get('location')).toBe(`/groups/${UNSLUGGED}/stats`)
    expect((await get(`/${SLUGGED}/stats`)).headers.get('location')).toBe('/household/stats')
  })

  it('serves the page for slugs, unknown IDs and writes', async () => {
    for (const path of ['/household', '/household/expenses', `/groups/${'x'.repeat(21)}/expenses`, `/${'Y'.repeat(21)}/expenses`]) {
      const response = await get(path)
      expect(response.status, path).toBe(200)
    }
    expect((await get(`/groups/${SLUGGED}/balances`, 'POST')).status).toBe(200)
  })
})

/** Node, which runs the tests, needs `duplex` to send a streamed body. Bun, which runs the server, does not. */
class StreamingRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init?.body ? Object.assign({}, init, { duplex: 'half' }) : init)
  }
}

describe('RPC request IDs', () => {
  it('returns the request ID in a header and logs a failed call with it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('Request', StreamingRequest)
    try {
      const response = await h.fetch(
        new Request(`${BASE}/api/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE },
          body: JSON.stringify([{ _tag: 'Request', id: '1', tag: 'groups.directory', payload: { offset: 0 }, headers: [] }]),
        }),
      )
      expect(response.status).toBe(200)
      const id = response.headers.get('x-request-id') ?? ''
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
      // Signed out: the call answers Unauthorized, and the log line names the same ID.
      expect(JSON.stringify(await response.json())).toContain('Unauthorized')
      expect(warn).toHaveBeenCalledWith('RPC groups.directory answered Unauthorized', { requestId: id })
    } finally {
      vi.unstubAllGlobals()
      warn.mockRestore()
    }
  })
})

describe('origins', () => {
  // The session cookie alone must never authorize a cross-site write.
  it('refuses RPC calls and receipt uploads from another origin, and from a request without one', async () => {
    for (const path of ['/api/rpc', '/api/receipts'])
      for (const headers of [{ origin: 'https://evil.example' }, {}]) {
        const response = await h.fetch(new Request(`${BASE}${path}`, { method: 'POST', headers, body: '[]' }))
        expect({ path, headers, status: response.status, body: await response.json() }).toEqual({ path, headers, status: 403, body: { error: 'Origin not allowed' } })
      }
  })
})

/** A daily series in a new group of `app`, due since 2026-11-01. Returns a count of the group's expenses. */
async function dailySeries(app: Harness, tag: string) {
  const [owner, groupId, pa] = [`${tag}-owner`, `g-${tag}`, `${tag}-pa`]
  await app.account(owner)
  await app.group({ id: groupId, people: [pa], members: [[owner, pa, 'admin']] })
  await app.tx((tx) =>
    createExpense(tx, { principal: principal(owner), groupId, expenseId: `${tag}-daily`, idempotencyKey: null, expense: draft({ payer: pa, people: [pa], recurrence: 'daily' }) }),
  )
  return async () => (await app.withDb((db) => db.select({ n: count() }).from(expenses).where(eq(expenses.groupId, groupId))))[0]?.n ?? 0
}
/** The hourly job's minute on 2026-12-01. */
const DECEMBER = new Date('2026-12-01T00:07:00Z')

describe('the hourly job', () => {
  it('creates the due occurrences of a recurring expense when the app is not paused', async () => {
    const expenseCount = await dailySeries(h, 'running')
    await h.app.scheduled(DECEMBER)
    expect(await expenseCount()).toBeGreaterThan(1)
  })
})

describe('maintenance', () => {
  // The cutover relies on this: users and agents get 503, Coolify's health check passes, and nothing writes.
  it('answers 503 to pages, RPC, MCP and uploads, lets the health checks through, and pauses the hourly job', async () => {
    const paused = await startHarness({ maintenance: true })
    try {
      for (const path of ['/api/health', '/api/health/readiness', '/api/health/liveness']) expect((await paused.fetch(new Request(`${BASE}${path}`))).status, path).toBe(200)
      const page = await paused.fetch(new Request(`${BASE}/household`, { headers: { accept: 'text/html,*/*' } }))
      expect(page.status).toBe(503)
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(page.headers.get('x-frame-options')).toBe('DENY')
      for (const path of ['/api/rpc', '/api/mcp', '/api/receipt-uploads/x']) {
        const response = await paused.fetch(new Request(`${BASE}${path}`, { method: 'POST', headers: { accept: 'application/json' } }))
        expect({ path, status: response.status, retryAfter: response.headers.get('retry-after') }).toEqual({ path, status: 503, retryAfter: '300' })
      }
      // A daily expense due since November: the paused job creates none of its occurrences.
      const expenseCount = await dailySeries(paused, 'paused')
      await paused.app.scheduled(DECEMBER)
      expect(await expenseCount()).toBe(1)
    } finally {
      await paused.close()
    }
  })
})
