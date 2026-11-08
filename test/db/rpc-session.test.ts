// The RPC session check runs once per HTTP request, for every call of its
// batch (src/server/rpc.ts). A check per call is silent: each screen's batch
// sends one more statement per call, and nothing else changes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE, startHarness, type Harness } from './harness'

let h: Harness
let cookie = ''
beforeAll(async () => {
  h = await startHarness({ perf: true })
  cookie = (await h.account('sam', { name: 'Sam' })).cookie
})
afterAll(() => h.close())

/** A batch of `calls` session.me calls in one request: the statements it sent, and its answers. */
async function batch(data: { calls: number; cookie: string }) {
  const response = await h.fetch(
    new Request(`${BASE}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, ...(data.cookie ? { cookie: data.cookie } : {}) },
      body: JSON.stringify(Array.from({ length: data.calls }, (_, i) => ({ _tag: 'Request', id: String(i + 1), tag: 'session.me', payload: null, headers: [] }))),
    }),
  )
  const exits = (await response.json()) as { exit: { _tag: string; value: unknown } }[]
  return { queries: Number(response.headers.get('x-perf-db-queries')), values: exits.map((e) => e.exit.value) }
}

describe('the RPC session check', () => {
  it('looks the session up once for all the calls of one request', async () => {
    const one = await batch({ calls: 1, cookie })
    const three = await batch({ calls: 3, cookie })
    expect(one.queries).toBe(1)
    expect(three.queries).toBe(1)
    expect(three.values).toEqual([1, 2, 3].map(() => ({ userId: 'sam', name: 'Sam', email: expect.any(String) })))
  })

  it('answers each request with its own cookie', async () => {
    expect((await batch({ calls: 2, cookie: '' })).values).toEqual([null, null])
    expect((await batch({ calls: 1, cookie })).values).toEqual([{ userId: 'sam', name: 'Sam', email: expect.any(String) }])
  })
})
