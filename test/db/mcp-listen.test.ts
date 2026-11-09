// subscriptions/listen. The SDK answers it with an event stream that ends only
// when the client leaves, and the MCP endpoint keeps its request's database
// connection until the answer is complete. On 9 November 2026 five of these
// requests from Claude held all five connections of the production pool, and
// every page that reads the database answered 503 for 90 minutes.
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MCP_URL, startHarness, testApp, type Harness } from './harness'

const MODERN = '2026-07-28'
const ANSWER_MS = 2_000

let h: Harness
let key: string

beforeAll(async () => {
  h = await startHarness()
  await h.account('alice')
  key = await h.apiKey('alice')
})
afterAll(() => h.close())

/** The app on the harness pool, counting the connections it holds. */
function countedApp() {
  let held = 0
  const connect = async (): Promise<PoolClient> => {
    const client = await h.pool.connect()
    held++
    const release = client.release.bind(client)
    client.release = (error?: Error | boolean) => {
      held--
      release(error)
    }
    return client
  }
  return { app: testApp({ pool: h.pool, connect }), held: () => held }
}

/** subscriptions/listen in the modern protocol, as Claude sends it. */
const listen = () =>
  new Request(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MODERN,
      'mcp-method': 'subscriptions/listen',
      'x-api-key': key,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'subscriptions/listen',
      params: {
        notifications: { toolsListChanged: true },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': { name: 'claude-ai', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  })

describe('subscriptions/listen', () => {
  it('is refused at once, and the request gives its database connection back', async () => {
    const { app, held } = countedApp()
    const answer = (async () => {
      const response = await app.fetch(listen())
      return { status: response.status, body: (await response.json()) as unknown }
    })()
    const late = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), ANSWER_MS))
    const reply = await Promise.race([answer, late])
    expect(reply).toEqual({ status: 404, body: { jsonrpc: '2.0', id: 7, error: { code: -32601, message: expect.any(String) } } })
    expect(held()).toBe(0)
  })
})
