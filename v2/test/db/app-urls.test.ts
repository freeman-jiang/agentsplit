// The server's half of the current app's group URLs (src/proxy.ts at bb26b78)
// and the request ID of RPC responses. A wrong redirect or a missing ID fails
// silently: old links stop working, or a quoted error reference finds no log line.
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { groups } from '../../db/schema/app'
import { createApp, type App } from '~/server/app'
import { makeDb } from '~/server/db'
import { fakeBucket } from './fake-bucket'
import { resetTestDatabase } from './setup'

const BASE = 'http://localhost'
const SLUGGED = 'AbCdEfGhIjKlMnOpQrS_1'
const UNSLUGGED = 'ZyXwVuTsRqPoNmLkJiH_2'

let pool: Pool
let app: App

beforeAll(async () => {
  pool = await resetTestDatabase()
  await makeDb(pool).insert(groups).values([
    { id: SLUGGED, kind: 'named', slug: 'household', name: 'Household', defaultCurrency: 'USD' },
    { id: UNSLUGGED, kind: 'named', slug: null, name: 'Trip', defaultCurrency: 'USD' },
  ])
  app = createApp({
    config: { baseUrl: BASE, secret: 'app-urls-test-secret-0123456789-0123456789', googleClientId: 'g', googleClientSecret: 'g', documentsEnabled: true, bootstrapEmail: undefined, perfInstrumentation: false },
    connect: () => pool.connect(),
    pool: makeDb(pool),
    bucket: fakeBucket().bucket,
    assets: async () => new Response('spa page', { headers: { 'Content-Type': 'text/html' } }),
  })
})
afterAll(async () => {
  await pool.end()
})

const get = (path: string, method = 'GET') => app.fetch(new Request(`${BASE}${path}`, { method, redirect: 'manual' }))

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
    expect(await page.text()).toBe('spa page')
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
      const response = await app.fetch(
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
