// A client that sends its body slowly, or never, or a storage endpoint that
// stalls, must not hold a database connection or stack bodies past the memory
// budget: five slow POSTs to /api/rpc used to hold the whole pool and answer
// every page with 503.
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Bucket } from '../../src/server/bucket'
import { withBufferedBody, withWholeBody } from '../../src/server/core/body'
import { mcpExpense } from '../kit/drafts'
import { id21 } from '../kit/ids'
import { png } from '../kit/images'
import { receiptUpload } from '../kit/upload'
import { BASE, MCP_URL, startHarness, testApp, type Harness } from './harness'

let h: Harness
let aliceCookie: string
let aliceKey: string

beforeAll(async () => {
  h = await startHarness()
  aliceCookie = (await h.account('alice', { name: 'Alice' })).cookie
  aliceKey = await h.apiKey('alice')
  await h.group({ id: 'g1', name: 'Home', people: ['pa'], members: [['alice', 'pa', 'admin']] })
})
afterAll(() => h.close())

const streamed = (path: string, start: (c: ReadableStreamDefaultController<Uint8Array>) => void, headers: Record<string, string> = {}) => {
  // Node needs `duplex` for a stream; the DOM types do not know it.
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, ...headers },
    body: new ReadableStream<Uint8Array>({ start }),
    duplex: 'half',
  }
  return new Request(`${BASE}${path}`, init)
}
/** A POST whose body never ends. */
const endless = (path: string, headers: Record<string, string> = {}) =>
  streamed(path, (c) => c.enqueue(new TextEncoder().encode('{"a":"')), headers)

function trackedApp(bucket?: Bucket) {
  let active = 0
  let total = 0
  const connect = async (): Promise<PoolClient> => {
    total++
    active++
    const client = await h.pool.connect()
    const release = client.release.bind(client)
    client.release = (err?: Error | boolean) => {
      active--
      release(err)
    }
    return client
  }
  return {
    app: testApp({ pool: h.pool, connect, bucket: bucket ?? h.storage.bucket }),
    active: () => active,
    total: () => total,
  }
}

it('holds no database connection while a body is on its way', async () => {
  const { app, total } = trackedApp()
  for (const path of ['/api/rpc', '/api/auth/oauth2/token']) void app.fetch(endless(path))
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(total()).toBe(0)
})

it('holds no database connection during slow receipt upload body or slow storage I/O', async () => {
  let heldDuringPut = -1
  let heldDuringGet = -1
  let heldDuringDelete = -1
  let activeFn = () => 0
  const slowBucket: Bucket = {
    ...h.storage.bucket,
    async put(key, body, options) {
      heldDuringPut = activeFn()
      return h.storage.bucket.put(key, body, options)
    },
    async get(key, options) {
      heldDuringGet = activeFn()
      return h.storage.bucket.get(key, options)
    },
    async delete(keys) {
      heldDuringDelete = activeFn()
      return h.storage.bucket.delete(keys)
    },
  }
  const tracked = trackedApp(slowBucket)
  activeFn = tracked.active

  // 1. Browser POST /api/receipts: slow body never holds a DB connection.
  const slowMultipart = new Request(`${BASE}/api/receipts`, {
    method: 'POST',
    headers: {
      origin: BASE,
      cookie: aliceCookie,
      'content-type': 'multipart/form-data; boundary=x',
      'content-length': '1024',
    },
    body: new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode('--x\r\n')) }),
    duplex: 'half',
  } as RequestInit)
  void tracked.app.fetch(slowMultipart)
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(tracked.active()).toBe(0)

  // 2. Normal POST /api/receipts holds 0 DB connections during bucket.put.
  const uploaded = await tracked.app.fetch(
    await receiptUpload({ baseUrl: BASE, groupId: 'g1', file: png({ width: 16, height: 16, bytes: 64 }), cookie: aliceCookie }),
  )
  expect(uploaded.status).toBe(200)
  expect(heldDuringPut).toBe(0)
  const receipt = (await uploaded.json()) as { id: string; url: string }

  // 3. GET /api/receipts holds 0 DB connections during bucket.get.
  const downloaded = await tracked.app.fetch(
    new Request(`${BASE}/api/receipts?${new URLSearchParams({ groupId: 'g1', url: receipt.url })}`, { headers: { cookie: aliceCookie } }),
  )
  expect(downloaded.status).toBe(200)
  await downloaded.arrayBuffer()
  expect(heldDuringGet).toBe(0)

  // 4. Agent PUT /api/receipt-uploads/<token> holds 0 DB connections during bucket.put.
  const image = png({ width: 16, height: 16, bytes: 64 })
  const created = await h.mcp.ok({
    name: 'create_expense',
    args: {
      groupId: 'g1',
      expenseId: id21('s', 1),
      expense: mcpExpense({ paidBy: 'pa', people: ['pa'], title: 'Lunch', amount: '12' }),
      uploads: [{ filename: 'r.png', contentType: 'image/png', bytes: image.length }],
    },
    headers: { 'x-api-key': aliceKey },
  })
  const [target] = created['uploads'] as { url: string; headers: Record<string, string> }[]
  if (!target) throw new Error('no upload target')
  heldDuringPut = -1
  const putRes = await tracked.app.fetch(new Request(target.url, { method: 'PUT', headers: target.headers, body: image }))
  expect(putRes.status).toBe(200)
  expect(heldDuringPut).toBe(0)

  // 5. RPC storage.deleteReceipts holds 0 DB connections during after-commit bucket.delete.
  const delRes = await tracked.app.fetch(
    new Request(`${BASE}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: aliceCookie, origin: BASE },
      body: JSON.stringify([{ _tag: 'Request', id: '1', tag: 'storage.deleteReceipts', payload: { receiptIds: [receipt.id] }, headers: [] }]),
    }),
  )
  expect(delRes.status).toBe(200)
  expect(heldDuringDelete).toBe(0)
  expect(tracked.active()).toBe(0)
})

it('refuses oversized RPC and MCP batches, and batched subscriptions/listen', async () => {
  const { app, total } = trackedApp()
  const bigRpcBatch = Array.from({ length: 33 }, (_, i) => ({ _tag: 'Request', id: String(i), tag: 'session.me', payload: null, headers: [] }))
  const rpcRes = await app.fetch(
    new Request(`${BASE}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify(bigRpcBatch),
    }),
  )
  expect(rpcRes.status).toBe(400)
  expect(total()).toBe(0)

  const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': aliceKey }
  const bigMcpBatch = Array.from({ length: 17 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'ping' }))
  const mcpBatchRes = await app.fetch(new Request(MCP_URL, { method: 'POST', headers: mcpHeaders, body: JSON.stringify(bigMcpBatch) }))
  expect(mcpBatchRes.status).toBe(400)

  const listenBatch = await app.fetch(
    new Request(MCP_URL, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify([{ jsonrpc: '2.0', id: 9, method: 'subscriptions/listen' }]),
    }),
  )
  expect(listenBatch.status).toBe(404)
})

it('holds the body memory budget until the handler finishes', async () => {
  const chunk = new Uint8Array(4 * 1024 * 1024)
  const releases: (() => void)[] = []
  const started = () =>
    withBufferedBody(new Request(BASE, { method: 'POST', body: chunk.slice() }), { maxBytes: 5 * 1024 * 1024 }, () =>
      new Promise<Response>((resolve) => {
        releases.push(() => resolve(new Response('ok')))
      }),
    )
  // 8 × ~3.94 MiB (~31.5 MiB above FREE_BYTES) fits in the 32 MiB budget; the 9th must be refused with 503 while they are in flight.
  const inflight = Array.from({ length: 8 }, () => started())
  await new Promise((resolve) => setTimeout(resolve, 100))
  const ninth = await withBufferedBody(new Request(BASE, { method: 'POST', body: chunk.slice() }), { maxBytes: 5 * 1024 * 1024 }, async () => new Response('ok'))
  expect(ninth.status).toBe(503)
  for (const r of releases) r()
  const settled = await Promise.all(inflight)
  expect(settled.every((r) => r.status === 200)).toBe(true)
  // Once finished, the budget is free again.
  const after = await withBufferedBody(new Request(BASE, { method: 'POST', body: chunk.slice() }), { maxBytes: 5 * 1024 * 1024 }, async () => new Response('ok'))
  expect(after.status).toBe(200)
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
