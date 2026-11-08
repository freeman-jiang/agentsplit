// The stored MCP answers (src/server/mcp/answers.ts). A wrong stored answer is
// silent: an agent gets another request's ID, another protocol's answer, or a
// gzip body that it cannot read, and the session fails on the client.
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { staticAnswer } from '~/server/mcp/answers'
import { LEGACY } from '../kit/mcp'
import { MCP_URL, startHarness, type Harness } from './harness'

let h: Harness
let alice: Record<string, string>

beforeAll(async () => {
  h = await startHarness()
  await h.account('alice', { name: 'Alice' })
  alice = { 'x-api-key': await h.apiKey('alice') }
})
afterAll(() => h.close())

type Message = { readonly id?: string | number; readonly method: string; readonly params?: object }

/** One POST to the endpoint; the body as text, gunzipped when the answer is gzipped. */
async function post(data: { message: Message; headers?: Record<string, string>; gzip?: boolean }) {
  const response = await h.fetch(
    new Request(MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': LEGACY,
        ...(data.gzip ? { 'accept-encoding': 'gzip' } : {}),
        ...(data.headers ?? alice),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...data.message }),
    }),
  )
  const bytes = new Uint8Array(await response.arrayBuffer())
  const gzipped = response.headers.get('content-encoding') === 'gzip'
  const body = new TextDecoder().decode(gzipped ? gunzipSync(bytes) : bytes)
  // Legacy exchanges answer as one SSE event; `text` is its JSON.
  const text = body.match(/^data: (.*)$/m)?.[1] ?? body
  return { status: response.status, headers: response.headers, gzipped, body, text }
}

const initialize = (protocolVersion: string): object => ({ protocolVersion, capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.314' } })

describe('stored MCP answers', () => {
  it.each([
    ['tools/list', {}],
    ['initialize', initialize(LEGACY)],
  ])('answer %s again with the SDK’s result and the caller’s own ID, plain or gzipped', async (method, params) => {
    const first = await post({ message: { id: 1, method, params } })
    expect(first.status).toBe(200)
    const sdk = JSON.parse(first.text) as { id: unknown; result: unknown }
    expect(sdk.id).toBe(1)
    for (const [id, gzip] of [['next', true], [7, false], [123456789, true]] as const) {
      const again = await post({ message: { id, method, params }, gzip })
      expect(again.status).toBe(200)
      expect(again.gzipped).toBe(gzip)
      expect(JSON.parse(again.text)).toEqual({ ...sdk, id })
      // The same framing as the SDK's answer around the JSON.
      expect(again.body.replace(again.text, '')).toBe(first.body.replace(first.text, ''))
      expect(again.headers.get('content-type')).toBe(first.headers.get('content-type'))
      expect(again.headers.get('cache-control')).toBe('no-store')
      expect(again.headers.get('vary')).toBe('Accept-Encoding')
    }
  })

  it('keep the answers of other protocol versions and messages apart', async () => {
    const versions = ['2025-03-26', '2025-06-18', '2025-03-26']
    for (const [n, protocolVersion] of versions.entries()) {
      const r = await post({ message: { id: n, method: 'initialize', params: initialize(protocolVersion) } })
      expect((JSON.parse(r.text) as { result: { protocolVersion: string } }).result.protocolVersion).toBe(protocolVersion)
    }
    // An initialize without its required fields is the SDK's error each time, never a stored answer.
    for (const id of [1, 2]) {
      const r = await post({ message: { id, method: 'initialize', params: {} } })
      expect(JSON.parse(r.text)).toMatchObject({ id, error: expect.objectContaining({ code: expect.any(Number) }) })
    }
  })

  it('answer notifications/initialized with the SDK’s empty 202 each time', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await post({ message: { method: 'notifications/initialized' } })
      expect(r.status).toBe(202)
      expect(r.text).toBe('')
    }
  })

  it('still authenticate the caller first', async () => {
    await post({ message: { id: 1, method: 'tools/list' } })
    const anonymous = await post({ message: { id: 2, method: 'tools/list' }, headers: {} })
    expect(anonymous.status).toBe(401)
    const wrong = await post({ message: { id: 3, method: 'tools/list' }, headers: { 'x-api-key': 'agentsplit_wrong' } })
    expect(wrong.status).toBe(401)
  })

  it('ask the SDK once per message and headers, in either answer form', async () => {
    for (const [type, frame] of [['text/event-stream', (json: string) => `event: message\ndata: ${json}\n\n`], ['application/json', (json: string) => json]] as const) {
      let calls = 0
      const serve = async () => {
        calls++
        return new Response(frame(JSON.stringify({ result: { tools: [{ name: 'x'.repeat(2000) }] }, jsonrpc: '2.0', id: 1 })), { headers: { 'content-type': type } })
      }
      const request = (version: string) =>
        new Request(MCP_URL, { method: 'POST', headers: { accept: type, 'content-type': 'application/json', 'mcp-protocol-version': version, 'accept-encoding': 'gzip' } })
      const body = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} })
      for (const id of [1, 2, 3]) await staticAnswer({ request: request(LEGACY), body: body(id), serve })
      expect(calls).toBe(1)
      const other = await staticAnswer({ request: request('2025-03-26'), body: body(4), serve })
      expect(calls).toBe(2)
      expect(other.headers.get('content-encoding')).toBeNull()
      const stored = await staticAnswer({ request: request('2025-03-26'), body: body(5), serve })
      expect(calls).toBe(2)
      expect(stored.headers.get('content-encoding')).toBe('gzip')
      expect(new TextDecoder().decode(gunzipSync(new Uint8Array(await stored.arrayBuffer())))).toBe(frame(JSON.stringify({ result: { tools: [{ name: 'x'.repeat(2000) }] }, jsonrpc: '2.0', id: 5 })))
    }
  })
})
