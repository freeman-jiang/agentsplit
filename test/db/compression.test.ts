// Gzip at the origin (src/server/compression.ts). A failure is silent: the app
// still works, but each API answer leaves the VM at full size and costs
// money, or a stream is read into memory, or a static file is compressed twice.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assetHandler, loadAssets } from '~/server/assets'
import { compressed, gzipWithTail } from '~/server/compression'
import { png } from '../kit/images'
import { receiptUpload } from '../kit/upload'
import { BASE, startHarness, testApp, type Harness } from './harness'

let h: Harness
let cookie = ''
const people = Array.from({ length: 40 }, (_, i) => `p-${i}`)

beforeAll(async () => {
  h = await startHarness()
  cookie = (await h.account('zoe')).cookie
  await h.group({ id: 'big', people, members: [['zoe', 'p-0', 'admin']] })
})
afterAll(() => h.close())

/** groups.get over RPC for the group of 40 people, with the given Accept-Encoding. */
const groupCall = (acceptEncoding: string | null) =>
  h.fetch(
    new Request(`${BASE}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: BASE, ...(acceptEncoding ? { 'accept-encoding': acceptEncoding } : {}) },
      body: JSON.stringify([{ _tag: 'Request', id: '1', tag: 'groups.get', payload: { groupId: 'big' }, headers: [] }]),
    }),
  )

describe('origin compression', () => {
  it('gzips a large RPC answer for a client that accepts gzip, and sends it plain to one that does not', async () => {
    const plain = await groupCall(null)
    const text = await plain.text()
    expect(text).toContain('Name p-39')
    expect(text.length).toBeGreaterThan(1024)
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(plain.headers.get('vary')).toContain('Accept-Encoding')

    const zipped = await groupCall('gzip, deflate, br')
    expect(zipped.headers.get('content-encoding')).toBe('gzip')
    expect(zipped.headers.get('vary')).toContain('Accept-Encoding')
    const bytes = new Uint8Array(await zipped.arrayBuffer())
    expect(bytes.byteLength).toBeLessThan(text.length / 2)
    expect(gunzipSync(bytes).toString()).toBe(text)

    expect((await groupCall('gzip;q=0')).headers.get('content-encoding')).toBeNull()
  })

  it('gzips a buffered event-stream answer, as the MCP endpoint sends one', async () => {
    const event = `event: message\ndata: ${JSON.stringify({ result: { text: 'x'.repeat(4000) } })}\n\n`
    const response = compressed({
      request: new Request(`${BASE}/api/mcp`, { method: 'POST', headers: { 'accept-encoding': 'gzip' } }),
      body: new TextEncoder().encode(event).buffer,
      init: { status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }) },
    })
    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(new Uint8Array(await response.arrayBuffer())).toString()).toBe(event)
  })

  it('leaves the receipt ZIP stream as it is', async () => {
    const upload = await h.fetch(await receiptUpload({ baseUrl: BASE, groupId: 'big', file: png({ width: 40, height: 30, bytes: 4096 }), cookie }))
    expect(upload.status).toBe(200)
    const response = await h.fetch(new Request(`${BASE}/groups/big/expenses/export/receipts`, { headers: { cookie, 'accept-encoding': 'gzip' } }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-encoding')).toBeNull()
    const zip = new Uint8Array(await response.arrayBuffer())
    // A ZIP file starts with a local file header.
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50)
  })

  it('sends a static file’s own Brotli copy, not a second encoding of it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsplit-compression-'))
    try {
      mkdirSync(join(dir, 'assets'))
      writeFileSync(join(dir, 'index.html'), '<!doctype html><title>AgentSplit</title>')
      const chunk = 'export const a = 1;'.repeat(200)
      const br = brotliCompressSync(chunk)
      writeFileSync(join(dir, 'assets', 'index-abc123.js'), chunk)
      writeFileSync(join(dir, 'assets', 'index-abc123.js.br'), br)
      const assets = loadAssets({ dir, baseUrl: BASE })
      if (!assets) throw new Error('no assets')
      const app = testApp({ pool: h.pool, assets: assetHandler(assets) })
      const response = await app.fetch(new Request(`${BASE}/assets/index-abc123.js`, { headers: { 'accept-encoding': 'gzip, deflate, br' } }))
      expect(response.headers.get('content-encoding')).toBe('br')
      expect(response.headers.get('vary')).toBe('Accept-Encoding')
      expect(Buffer.from(await response.arrayBuffer()).equals(br)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('gzip with a changing tail', () => {
  it('makes one gzip member that decodes to the head and each tail', () => {
    const encoder = new TextEncoder()
    for (const size of [0, 1, 1000, 70_000, 200_000]) {
      const head = encoder.encode(JSON.stringify({ result: { text: 'tool '.repeat(size / 5) }, jsonrpc: '2.0' }).slice(0, -1) + ',"id":')
      const gzip = gzipWithTail(head)
      for (const tail of ['1}', '"a-long-request-id-0123456789"}', '}']) {
        const out = gzip(encoder.encode(tail))
        expect(Buffer.from(gunzipSync(out)).equals(Buffer.concat([head, encoder.encode(tail)]))).toBe(true)
      }
    }
  })
})

