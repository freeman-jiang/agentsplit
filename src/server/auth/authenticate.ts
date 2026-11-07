// Who is calling the MCP endpoint: an API key or an OAuth access token, with
// the current app's rules (src/lib/mcp/authenticate.ts, src/lib/api-key-header.ts).
import type { Db } from '../core/db'
import type { Principal } from '../core/access'
import { verifyApiKey } from './api-key'
import { jsonError, noStore } from '../core/errors'
import { requestSession } from './session'
import { challenge } from './challenge'
import { verifyOAuthRequest } from './oauth'
import type { OAuthResult } from './oauth-connections'

/** The ledger principal, plus the OAuth connection and its scope ceiling. API keys have neither. */
export type McpPrincipal = Principal & { readonly scopes: readonly string[] | null; readonly oauthConnectionId: string | null }

export type Authentication = { readonly principal: McpPrincipal } | { readonly response: Response }

const validKey = (key: string) => key.length >= 32 && key.length <= 4096 && /^[^\s,]+$/.test(key)

/**
 * The raw API key from `X-API-Key` or `Authorization: Bearer`. Both may be
 * sent only with the same key: the server never picks one of two identities,
 * and a malformed header never falls back to the other one.
 */
export function readApiKey(headers: Headers): string | undefined {
  const direct = headers.get('x-api-key')
  const authorization = headers.get('authorization')
  const bearer = authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1]
  if (authorization !== null && !bearer) return undefined
  if (direct !== null && !validKey(direct)) return undefined
  if (bearer !== undefined && !validKey(bearer)) return undefined
  if (direct !== null && bearer !== undefined && direct !== bearer) return undefined
  return direct ?? bearer
}

const unavailable = () => jsonError({ status: 503, message: 'Authentication is temporarily unavailable' })

/** The answer to an OAuth request that verifyOAuthRequest refused. The MCP endpoint and UserInfo answer the same. */
export function oauthRefusal(data: { result: Exclude<OAuthResult, { kind: 'ok' }>; baseUrl: string }): Response {
  if (data.result.kind === 'no-read') return challenge({ baseUrl: data.baseUrl, status: 403, message: 'Read permission is no longer granted' })
  return challenge({ baseUrl: data.baseUrl })
}

async function oauth(db: Db, data: { request: Request; baseUrl: string }): Promise<Authentication> {
  const result = await verifyOAuthRequest(db, data)
  if (result.kind !== 'ok') return { response: oauthRefusal({ result, baseUrl: data.baseUrl }) }
  return {
    principal: {
      userId: result.userId,
      name: result.name,
      email: result.email,
      source: 'agent',
      agentKeyId: `oauth:${result.connectionId}`,
      scopes: result.scopes,
      oauthConnectionId: result.connectionId,
    },
  }
}

export async function authenticate(db: Db, data: { request: Request; baseUrl: string }): Promise<Authentication> {
  const { request, baseUrl } = data
  const headers = request.headers
  try {
    const authorization = headers.get('authorization')
    if (!headers.has('x-api-key') && /^DPoP [^\s,]{32,16384}$/i.test(authorization ?? '')) return await oauth(db, data)
    const key = readApiKey(headers)
    if (!key) return { response: challenge({ baseUrl }) }
    // Issued API keys are opaque. OAuth access JWTs use the compact three-part form.
    if (!headers.has('x-api-key') && key.split('.').length === 3) return await oauth(db, data)
    const verified = await verifyApiKey(db, key)
    if (!verified.valid) {
      // The current app answered a rate-limited key with 401; v2 answers 429 (DECISIONS.md, P-MCP-56).
      if (verified.code === 'RATE_LIMITED')
        return {
          response: Response.json(
            { error: 'API key request rate exceeded' },
            { status: 429, headers: { ...noStore, 'Retry-After': String(Math.max(1, Math.ceil(verified.tryAgainInMs / 1000))) } },
          ),
        }
      if (headers.has('x-api-key')) return { response: challenge({ baseUrl }) }
      return await oauth(db, data)
    }
    const account = verified.owner
    if (!account?.verified) return { response: challenge({ baseUrl }) }
    return {
      principal: { userId: account.id, name: account.name, email: account.email, source: 'agent', agentKeyId: verified.key.id, scopes: null, oauthConnectionId: null },
    }
  } catch (error) {
    console.error('MCP authentication failed', error)
    return { response: unavailable() }
  }
}

/**
 * The caller of a read that agents also make over plain HTTP (receipts and
 * exports). An `X-API-Key` or `Authorization` header takes the MCP path and
 * the session cookie is then ignored, as in the current app (P-AUTH-45,
 * P-AUTH-47). A failed agent credential keeps the MCP endpoint's answer (403,
 * 429, 503); a refused or missing credential gets 401 with the route's
 * `signIn` text, as the current app answered.
 */
export type Reader = { readonly principal: Principal } | { readonly response: Response }

export async function httpReader(db: Db, data: { request: Request; baseUrl: string; secret: string; signIn: string }): Promise<Reader> {
  const headers = data.request.headers
  const signIn = () => ({ response: jsonError({ status: 401, message: data.signIn }) })
  if (headers.has('x-api-key') || headers.has('authorization')) {
    const result = await authenticate(db, { request: data.request, baseUrl: data.baseUrl })
    return 'response' in result && result.response.status === 401 ? signIn() : result
  }
  const principal = await requestSession(db, data)
  return principal ? { principal } : signIn()
}
