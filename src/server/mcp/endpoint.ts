// The /api/mcp endpoint: MCP Streamable HTTP in stateless JSON mode, as the
// current app serves it (src/app/api/mcp/route.ts). Order: host and origin,
// authentication, the rate limit, the scope step-up, the protocol header, then
// the JSON-RPC call.
import { createMcpHandler, isLegacyRequest } from '@modelcontextprotocol/server'
import type { WithDb } from '../calls'
import type { Db } from '../core/db'
import { authenticate, type Authentication, type McpPrincipal } from '../auth/authenticate'
import { withBufferedBody } from '../core/body'
import { jsonError, noStore } from '../core/errors'
import { challenge } from '../auth/challenge'
import { OAUTH_WRITE_SCOPE } from '../../shared/account'
import { originAllowed } from '../auth/origin'
import { takeMcpRequest } from '../rate-limit'
import { staticAnswer } from './answers'
import { createServer, isWriteTool, type McpSettings } from './server'

/** The SDK's own default request limit, applied here because this module reads the body itself. */
const MAX_BODY = 4 * 1024 * 1024
/** Maximum messages in a legacy JSON-RPC batch, so one HTTP call cannot amplify work past rate limits. */
const MAX_MCP_BATCH = 16

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The tools/call names in a JSON-RPC message or batch. */
function calledTools(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body]
  return messages.flatMap((m) => (isObject(m) && m['method'] === 'tools/call' && isObject(m['params']) && typeof m['params']['name'] === 'string' ? [m['params']['name']] : []))
}

/**
 * A call that needs write scope with a token that lacks it is refused with an
 * HTTP 403 step-up challenge before it runs. The current app answered 200 with
 * the challenge inside the result, and MCP clients never re-authorized
 * (docs/history/v2/OAUTH-CLAUDE-CODE.md).
 */
function needsStepUp(principal: McpPrincipal, body: unknown) {
  return principal.scopes !== null && !principal.scopes.includes(OAUTH_WRITE_SCOPE) && calledTools(body).some(isWriteTool)
}

/** The MCP spec's DNS-rebinding guard: the Host must be the app's, and an Origin, when sent, the app's origin. */
function hostAllowed(request: Request, baseUrl: string) {
  const host = request.headers.get('host') ?? new URL(request.url).host
  return host === new URL(baseUrl).host && originAllowed({ request, baseUrl, cookieWrite: false })
}

/** The caller, if the credentials and the request budget allow the request. */
async function admit(db: Db, data: { request: Request; baseUrl: string }): Promise<Authentication> {
  const authentication = await authenticate(db, data)
  if ('response' in authentication) return authentication
  let retryAfter: number
  try {
    retryAfter = await takeMcpRequest(db, { userId: authentication.principal.userId })
  } catch (error) {
    console.error('MCP rate limit failed', error)
    return { response: jsonError({ status: 503, message: 'MCP is temporarily unavailable' }) }
  }
  if (retryAfter) return { response: jsonError({ status: 429, message: 'MCP request rate exceeded', headers: { 'Retry-After': String(retryAfter) } }) }
  return authentication
}

export async function handleMcp(request: Request, data: { withDb: WithDb; settings: McpSettings }): Promise<Response> {
  const { withDb, settings } = data
  const { baseUrl } = settings
  if (!hostAllowed(request, baseUrl)) return jsonError({ status: 403, message: 'Origin or host is not allowed' })

  // The caller first, so a stranger's body is never read. The connection goes back before the body is read.
  const caller = await withDb((db) => admit(db, { request, baseUrl }))
  if ('response' in caller) return caller.response
  const { principal } = caller

  // Stateless MCP only accepts POST; refuse GET/DELETE without taking another DB connection or entering the SDK.
  if (request.method !== 'POST') {
    return Response.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
      { status: 405, headers: { ...noStore, Allow: 'POST' } },
    )
  }

  return withBufferedBody(request, { maxBytes: MAX_BODY }, async (whole) => {
    const text = await whole.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      // Not JSON: the SDK answers with its parse error.
    }
    if (Array.isArray(body) && body.length > MAX_MCP_BATCH) {
      return Response.json(
        { jsonrpc: '2.0', id: null, error: { code: -32600, message: `JSON-RPC batch may contain at most ${MAX_MCP_BATCH} messages` } },
        { status: 400, headers: noStore },
      )
    }
    if (needsStepUp(principal, body)) return challenge({ baseUrl, status: 403 })

    // The SDK leaves this modern-protocol header check to the mounting server.
    if (body !== undefined && !(await isLegacyRequest(whole, body)) && !whole.headers.get('mcp-protocol-version')) {
      const id = isObject(body) && (typeof body['id'] === 'string' || typeof body['id'] === 'number') ? body['id'] : null
      return Response.json({ jsonrpc: '2.0', id, error: { code: -32020, message: 'MCP-Protocol-Version is required' } }, { status: 400, headers: noStore })
    }

    // AgentSplit sends no notifications: its tools never change, and it has no resources or prompts.
    // The SDK would answer subscriptions/listen with an event stream that ends only when the client
    // leaves (test/db/mcp-listen.test.ts). Refuse it both standalone and inside a batch.
    const listen = (Array.isArray(body) ? body : [body]).find((m) => isObject(m) && m['method'] === 'subscriptions/listen')
    if (isObject(listen)) {
      const id = typeof listen['id'] === 'string' || typeof listen['id'] === 'number' ? listen['id'] : null
      return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: AgentSplit sends no notifications' } }, { status: 404, headers: noStore })
    }

    // initialize, tools/list and notifications/initialized are the same for every caller (answers.ts).
    const response = await staticAnswer({ request: whole, body, serve: () => serve({ request: whole, text, body, withDb, principal, settings }) })
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-store')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  })
}

/** The SDK's answer to the request, read in full. Database connections are only taken inside tool calls. */
async function serve(data: { request: Request; text: string; body: unknown; withDb: WithDb; principal: McpPrincipal; settings: McpSettings }): Promise<Response> {
  const { request, text, body } = data
  const handler = createMcpHandler(() => createServer({ withDb: data.withDb, principal: data.principal, settings: data.settings }), { responseMode: 'json' })
  try {
    const forward = new Request(request.url, { method: 'POST', headers: request.headers, body: text })
    const response = await handler.fetch(forward, body === undefined ? {} : { parsedBody: body })
    // Read the whole body before close() ends the exchange.
    const payload = await response.arrayBuffer()
    return new Response(payload, { status: response.status, statusText: response.statusText, headers: response.headers })
  } finally {
    await handler.close()
  }
}
