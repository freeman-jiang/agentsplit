// The /api/mcp endpoint: MCP Streamable HTTP in stateless JSON mode, as the
// current app serves it (src/app/api/mcp/route.ts). Order: host and origin,
// authentication, the rate limit, the scope step-up, the protocol header, then
// the JSON-RPC call.
import { createMcpHandler, isLegacyRequest } from '@modelcontextprotocol/server'
import type { Bucket } from '../bucket'
import type { Db } from '../db'
import { authenticate, type McpPrincipal } from './authenticate'
import { jsonError, noStore } from '../security'
import { challenge } from './challenge'
import { OAUTH_WRITE_SCOPE } from './constants'
import { takeMcpRequest } from './rate-limit'
import { createServer, isWriteTool } from './server'

/** The SDK's own default request limit, applied here because this module reads the body itself. */
const MAX_BODY = 4 * 1024 * 1024

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
 * (docs/v2/OAUTH-CLAUDE-CODE.md).
 */
function needsStepUp(principal: McpPrincipal, body: unknown) {
  return principal.scopes !== null && !principal.scopes.includes(OAUTH_WRITE_SCOPE) && calledTools(body).some(isWriteTool)
}

function hostAllowed(request: Request, baseUrl: string) {
  const expected = new URL(baseUrl)
  const host = request.headers.get('host') ?? new URL(request.url).host
  const origin = request.headers.get('origin')
  return host === expected.host && (!origin || origin === expected.origin)
}

export async function handleMcp(request: Request, data: { db: Db; baseUrl: string; bucket: Bucket }): Promise<Response> {
  const { db, baseUrl } = data
  if (!baseUrl) return jsonError({ status: 503, message: 'Authentication is not configured' })
  if (!hostAllowed(request, baseUrl)) return jsonError({ status: 403, message: 'Origin or host is not allowed' })

  const authentication = await authenticate(db, { request, baseUrl })
  if ('response' in authentication) return authentication.response
  const { principal } = authentication

  let retryAfter: number
  try {
    retryAfter = await takeMcpRequest(db, principal.userId)
  } catch (error) {
    console.error('MCP rate limit failed', error)
    return jsonError({ status: 503, message: 'MCP is temporarily unavailable' })
  }
  if (retryAfter) return jsonError({ status: 429, message: 'MCP request rate exceeded', headers: { 'Retry-After': String(retryAfter) } })

  let text = ''
  let body: unknown
  if (request.method === 'POST') {
    text = await request.text()
    if (text.length > MAX_BODY) return jsonError({ status: 413, message: 'Request body is too large' })
    try {
      body = JSON.parse(text)
    } catch {
      // Not JSON: the SDK answers with its parse error.
    }
  }
  if (needsStepUp(principal, body)) return challenge({ baseUrl, status: 403 })

  // The SDK leaves this modern-protocol header check to the mounting server.
  if (request.method === 'POST' && body !== undefined && !(await isLegacyRequest(request, body)) && !request.headers.get('mcp-protocol-version')) {
    const id = isObject(body) && (typeof body['id'] === 'string' || typeof body['id'] === 'number') ? body['id'] : null
    return Response.json({ jsonrpc: '2.0', id, error: { code: -32020, message: 'MCP-Protocol-Version is required' } }, { status: 400, headers: noStore })
  }

  const handler = createMcpHandler(() => createServer({ db, principal, baseUrl, bucket: data.bucket }), { responseMode: 'json' })
  try {
    const forward = request.method === 'POST' ? new Request(request.url, { method: 'POST', headers: request.headers, body: text }) : request
    const response = await handler.fetch(forward, body === undefined ? {} : { parsedBody: body })
    // Read the whole body before close() ends the exchange.
    const payload = await response.arrayBuffer()
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-store')
    return new Response(payload, { status: response.status, statusText: response.statusText, headers })
  } finally {
    await handler.close()
  }
}
