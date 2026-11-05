// Who is calling the MCP endpoint: an API key or an OAuth access token, with
// the current app's rules (src/lib/mcp/authenticate.ts, src/lib/api-key-header.ts).
import { sql } from 'drizzle-orm'
import { Forbidden } from '../../shared/api'
import type { Db } from '../db'
import type { Principal } from '../ledger'
import { verifyApiKey } from './api-key'
import { jsonError, noStore } from '../security'
import { requestSession } from '../session'
import { challenge } from './challenge'
import { OAUTH_READ_SCOPE, OAUTH_WRITE_SCOPE } from './constants'
import { verifyOAuthRequest, type OAuthResult } from './oauth'

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

/**
 * Rechecks, inside a write's transaction, that an OAuth connection is live and
 * its consent still allows changes, so a revocation that races the request
 * cannot let the write commit (the current app's assertOAuthWriteAccess).
 */
export async function assertOAuthWrite(tx: Db, principal: McpPrincipal) {
  if (!principal.oauthConnectionId) return
  const result = await tx.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM oauth_connections c
      JOIN oauth_consent o ON o.user_id = c.user_id AND o.client_id = c.client_id AND o.scopes @> ARRAY[${OAUTH_READ_SCOPE}, ${OAUTH_WRITE_SCOPE}]::text[]
      WHERE c.id = ${principal.oauthConnectionId} AND c.revoked_at IS NULL AND c.user_id = ${principal.userId}
    ) AS ok`)
  if (!result.rows[0]?.ok || !principal.scopes?.includes(OAUTH_WRITE_SCOPE))
    throw new Forbidden({ message: 'This OAuth connection no longer has write permission' })
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
 * P-AUTH-47). A failed agent credential gives the MCP endpoint's answer.
 */
export async function httpReader(
  db: Db,
  data: { request: Request; baseUrl: string; secret: string },
): Promise<{ readonly principal: Principal | null } | { readonly response: Response }> {
  const headers = data.request.headers
  if (headers.has('x-api-key') || headers.has('authorization')) return authenticate(db, { request: data.request, baseUrl: data.baseUrl })
  return { principal: await requestSession(db, data) }
}
