// A client that sends its body slowly, or never, must not hold a database
// connection: five such POSTs to /api/rpc held the whole pool, and every page
// answered 503.
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { withWholeBody } from '../../src/server/core/body'
import { BASE, startHarness, testApp, type Harness } from './harness'

let h: Harness
beforeAll(async () => {
  h = await startHarness()
})
afterAll(() => h.close())

const streamed = (path: string, start: (c: ReadableStreamDefaultController<Uint8Array>) => void) => {
  // Node needs `duplex` for a stream; the DOM types do not know it.
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: new ReadableStream<Uint8Array>({ start }),
    duplex: 'half',
  }
  return new Request(`${BASE}${path}`, init)
}
/** A POST whose body never ends. */
const endless = (path: string) => streamed(path, (c) => c.enqueue(new TextEncoder().encode('{"a":"')))

it('holds no database connection while a body is on its way', async () => {
  let taken = 0
  const connect = async (): Promise<PoolClient> => {
    taken++
    return h.pool.connect()
  }
  const app = testApp({ pool: h.pool, connect })
  for (const path of ['/api/rpc', '/api/auth/oauth2/token']) void app.fetch(endless(path))
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(taken).toBe(0)
})

it('refuses a body that is late, too large or broken off', async () => {
  const statusOf = async (request: Request, maxBytes: number) => {
    const result = await withWholeBody(request, { maxBytes, timeoutMs: 50 })
    return result instanceof Response ? result.status : result.text()
  }
  const post = (body: string) => new Request(BASE, { method: 'POST', body })
  expect(await statusOf(endless('/'), 100)).toBe(408)
  expect(await statusOf(post('x'.repeat(101)), 100)).toBe(413)
  const twoParts = streamed('/', (c) => {
    c.enqueue(new Uint8Array(60))
    c.enqueue(new Uint8Array(60))
    c.close()
  })
  expect(await statusOf(twoParts, 100)).toBe(413)
  expect(await statusOf(streamed('/', (c) => c.error(new Error('gone'))), 100)).toBe(400)
  expect(await statusOf(post('kept'), 100)).toBe('kept')
})
