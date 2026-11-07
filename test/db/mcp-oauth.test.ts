// OAuth on the MCP endpoint, in process: Better Auth's real authorization
// server and the v2 MCP endpoint on one database. The first block emulates
// Claude Code step by step, as docs/v2/OAUTH-CLAUDE-CODE.md reproduced it.
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { expenses, memberships } from '../../db/schema/app'
import { oauthConsent } from '../../db/schema/auth'
import { revokeOAuthConnection } from '~/server/auth/oauth-connections'
import { removeExpiredDpopProofs } from '~/server/auth/oauth'
import { BASE, callTool, failure, MCP_URL, ok, rpc, SECRET, startHarness, type Harness } from './harness'

/** Claude Code's published Client ID Metadata Document, as served on 2026-11-05. */
const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata'
const CLAUDE_CODE_METADATA = {
  client_id: CLAUDE_CODE,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}
const CHALLENGE = `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/mcp", scope="agentsplit:read agentsplit:write offline_access"`
const ALL = 'agentsplit:read agentsplit:write offline_access'

let h: Harness
let alice: { id: string; cookie: string }
const realFetch = globalThis.fetch

beforeAll(async () => {
  h = await startHarness()
  alice = await h.account('alice', { name: 'Alice' })
  await h.account('bob', { name: 'Bob' })
  await h.group({ id: 'g1', name: 'Home', people: ['pa', 'pb'], members: [['alice', 'pa', 'admin'], ['bob', 'pb', 'member']] })
  await h.group({ id: 'g2', name: 'Bob only', people: ['qb'], members: [['bob', 'qb', 'admin']] })
  // The CIMD fetcher reaches the network through fetch; answer Claude Code's document only.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === CLAUDE_CODE) return Response.json(CLAUDE_CODE_METADATA)
    throw new Error(`Unexpected network request: ${url}`)
  })
})
afterAll(async () => {
  vi.stubGlobal('fetch', realFetch)
  await h.close()
})
afterEach(() => {
  vi.useRealTimers()
})

// ---------- a client, step by step ----------

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)))
const sha256 = async (text: string) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

type Tokens = { access_token: string; refresh_token?: string; expires_in: number; token_type: string; scope: string }

/** Authorization with PKCE (S256) and the resource indicator, through the consent page’s API. */
async function authorize(data: { clientId?: string; redirectUri?: string; scope?: string; consentScope?: string; accept?: boolean; cookie?: string; prompt?: 'consent' }) {
  const clientId = data.clientId ?? CLAUDE_CODE
  // Claude Code listens on a random loopback port; the registered URI has none.
  const redirectUri = data.redirectUri ?? `http://localhost:${40000 + Math.floor(Math.random() * 20000)}/callback`
  const verifier = random()
  const state = random(12)
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: data.scope ?? ALL,
    resource: MCP_URL,
    code_challenge: await sha256(verifier),
    code_challenge_method: 'S256',
    state,
    ...(data.prompt ? { prompt: data.prompt } : {}),
  })
  const cookie = data.cookie ?? alice.cookie
  const start = await h.fetch(new Request(`${BASE}/api/auth/oauth2/authorize?${query}`, { headers: { cookie, accept: 'text/html', 'sec-fetch-mode': 'navigate' } }))
  expect(start.status, await start.clone().text()).toBe(302)
  const consentPage = new URL(start.headers.get('location') ?? '', BASE)
  // A consent that already covers the scopes is remembered: the code comes back at once.
  if (consentPage.pathname === '/callback') {
    expect(data.accept ?? true).toBe(true)
    expect(consentPage.searchParams.get('state')).toBe(state)
    return { code: consentPage.searchParams.get('code') ?? '', error: consentPage.searchParams.get('error'), verifier, redirectUri, clientId }
  }
  expect(consentPage.pathname).toBe('/settings/connections/consent')
  const consent = await h.fetch(
    new Request(`${BASE}/api/auth/oauth2/consent`, {
      method: 'POST',
      headers: { cookie, origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: data.accept ?? true, oauth_query: consentPage.search.slice(1), ...(data.consentScope ? { scope: data.consentScope } : {}) }),
    }),
  )
  expect(consent.status, await consent.clone().text()).toBe(200)
  const target = new URL(((await consent.json()) as { url: string }).url)
  expect(target.searchParams.get('state')).toBe(state)
  return { code: target.searchParams.get('code') ?? '', error: target.searchParams.get('error'), verifier, redirectUri, clientId }
}

async function token(body: Record<string, string>, headers: Record<string, string> = {}) {
  return h.fetch(new Request(`${BASE}/api/auth/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ resource: MCP_URL, ...body }) }))
}

async function connect(data: Parameters<typeof authorize>[0] = {}): Promise<Tokens> {
  const a = await authorize(data)
  const r = await token({ grant_type: 'authorization_code', client_id: a.clientId, redirect_uri: a.redirectUri, code: a.code, code_verifier: a.verifier })
  expect(r.status, await r.clone().text()).toBe(200)
  return (await r.json()) as Tokens
}

const bearer = (t: Tokens | string) => ({ authorization: `Bearer ${typeof t === 'string' ? t : t.access_token}` })
const expense = (title: string) => ({
  groupId: 'g1',
  expense: { title, expenseDate: '2026-11-02', amount: '20', currencyCode: 'USD', paidBy: 'pa', paidFor: [{ participant: 'pa', shares: '1' }, { participant: 'pb', shares: '1' }], isReimbursement: false },
})
const countExpenses = () => h.withDb(async (db) => (await db.select().from(expenses)).length)

// ---------- Claude Code ----------

describe('Claude Code flow emulation', () => {
  let tokens: Tokens

  it('1. an unauthenticated call gets the 401 challenge for read, write and offline_access', async () => {
    const r = await rpc(h, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.314' } } })
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toBe(CHALLENGE)
  })

  it('2. discovery lists offline_access and the authorization server', async () => {
    const { protectedResourceMetadata } = await import('~/server/auth/challenge')
    const meta = (await protectedResourceMetadata(new Request(`${BASE}/.well-known/oauth-protected-resource/api/mcp`), BASE).json()) as { scopes_supported: string[]; authorization_servers: string[] }
    expect(meta.scopes_supported).toEqual(['agentsplit:read', 'agentsplit:write', 'offline_access'])
    expect(meta.authorization_servers).toEqual([`${BASE}/api/auth`])
  })

  it('3. authorize, consent and token with the challenge’s scope give a write token with a refresh token', async () => {
    tokens = await connect({ scope: ALL })
    expect(tokens.scope.split(' ').sort()).toEqual(['agentsplit:read', 'agentsplit:write', 'offline_access'])
    expect(tokens.refresh_token).toBeTruthy()
    expect(tokens.expires_in).toBe(300)
    expect(tokens).not.toHaveProperty('id_token')
  })

  it('4. reads and writes work', async () => {
    const init = await rpc(h, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.314' } }, headers: bearer(tokens) })
    expect(init.status).toBe(200)
    const groups = await ok(h, { name: 'list_groups', headers: bearer(tokens) })
    expect((groups['groups'] as { id: string }[]).map((g) => g.id)).toEqual(['g1'])
    const created = await ok(h, { name: 'create_expense', args: expense('OAuth dinner'), headers: bearer(tokens) })
    expect(created['revision']).toBe(1)
    // The audit row names the OAuth connection.
    const [row] = await h.withDb((db) => db.execute<{ agent_key_id: string; actor_user_id: string }>(sql`SELECT agent_key_id, actor_user_id FROM activities WHERE expense_id = ${created['expenseId'] as string}`)).then((r) => r.rows)
    expect(row?.actor_user_id).toBe('alice')
    expect(row?.agent_key_id).toMatch(/^oauth:/)
  })

  it('5. a read-only grant gets an HTTP 403 step-up challenge before the write runs, then re-authorizes', async () => {
    const readOnly = await connect({ scope: ALL, consentScope: 'agentsplit:read offline_access', prompt: 'consent' })
    expect(readOnly.scope.split(' ')).not.toContain('agentsplit:write')
    expect((await callTool(h, { name: 'list_groups', headers: bearer(readOnly) })).status).toBe(200)
    const before = await countExpenses()
    const r = await callTool(h, { name: 'create_expense', args: expense('Blocked'), headers: bearer(readOnly) })
    expect(r.status).toBe(403)
    expect(r.headers.get('www-authenticate')).toBe(`${CHALLENGE}, error="insufficient_scope"`)
    expect(await countExpenses()).toBe(before)
    // The client asks again; this time the user allows changes.
    const upgraded = await connect({ scope: ALL })
    expect((await ok(h, { name: 'create_expense', args: expense('After step-up'), headers: bearer(upgraded) }))['revision']).toBe(1)
  })

  it('6. after the access token expires, a refresh keeps the connection working', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 301_000)
    const expired = await rpc(h, { method: 'tools/list', headers: bearer(tokens) })
    expect(expired.status).toBe(401)
    expect(expired.headers.get('www-authenticate')).toBe(CHALLENGE)
    const r = await token({ grant_type: 'refresh_token', client_id: CLAUDE_CODE, refresh_token: tokens.refresh_token ?? '' })
    expect(r.status, await r.clone().text()).toBe(200)
    const refreshed = (await r.json()) as Tokens
    expect(refreshed.refresh_token).toBeTruthy()
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token)
    expect((await ok(h, { name: 'create_expense', args: expense('After refresh'), headers: bearer(refreshed) }))['revision']).toBe(1)
    tokens = refreshed
  })
})

// ---------- token checks ----------

describe('access tokens', () => {
  it('fail closed on a bad signature, an unknown key, a wrong scheme and a missing token', async () => {
    const t = await connect()
    const [head, body, signature] = t.access_token.split('.')
    const flipped = `${head}.${body}.${signature?.startsWith('A') ? 'B' : 'A'}${signature?.slice(1)}`
    const forged = `${b64url(new TextEncoder().encode(JSON.stringify({ alg: 'ES256', kid: 'nope' })))}.${body}.${random(64)}`
    for (const headers of [bearer(flipped), bearer(forged), { authorization: `Token ${t.access_token}` }, { authorization: 'Bearer ' }]) {
      const r = await rpc(h, { method: 'tools/list', headers })
      expect(r.status).toBe(401)
      expect(r.headers.get('www-authenticate')).toBe(CHALLENGE)
    }
  })

  it('end with revocation, and revocation leaves API keys working', async () => {
    const t = await connect()
    const key = await h.apiKey('alice')
    expect((await rpc(h, { method: 'tools/list', headers: bearer(t) })).status).toBe(200)
    await h.withDb((db) => revokeOAuthConnection(db, { userId: 'alice', clientId: CLAUDE_CODE }))
    expect((await rpc(h, { method: 'tools/list', headers: bearer(t) })).status).toBe(401)
    const refresh = await token({ grant_type: 'refresh_token', client_id: CLAUDE_CODE, refresh_token: t.refresh_token ?? '' })
    expect(refresh.status).toBeGreaterThanOrEqual(400)
    expect((await rpc(h, { method: 'tools/list', headers: { 'x-api-key': key } })).status).toBe(200)
    // Reconnecting never revives the old token.
    const again = await connect()
    expect((await rpc(h, { method: 'tools/list', headers: bearer(again) })).status).toBe(200)
    expect((await rpc(h, { method: 'tools/list', headers: bearer(t) })).status).toBe(401)
  })

  it('follow the current consent: write removed means step-up, read removed means 403', async () => {
    const t = await connect()
    expect((await ok(h, { name: 'create_expense', args: expense('Before reduce'), headers: bearer(t) }))['revision']).toBe(1)
    await h.withDb((db) => db.update(oauthConsent).set({ scopes: ['agentsplit:read', 'offline_access'] }).where(eq(oauthConsent.userId, 'alice')))
    const write = await callTool(h, { name: 'create_expense', args: expense('After reduce'), headers: bearer(t) })
    expect(write.status).toBe(403)
    expect(write.headers.get('www-authenticate')).toContain('error="insufficient_scope"')
    expect((await callTool(h, { name: 'list_groups', headers: bearer(t) })).status).toBe(200)
    await h.withDb((db) => db.update(oauthConsent).set({ scopes: ['offline_access'] }).where(eq(oauthConsent.userId, 'alice')))
    const read = await rpc(h, { method: 'tools/list', headers: bearer(t) })
    expect(read.status).toBe(403)
    expect(read.body).toEqual({ error: 'Read permission is no longer granted' })
    expect(read.headers.get('www-authenticate')).toBe(`${CHALLENGE}, error="insufficient_scope"`)
    await h.withDb((db) => db.update(oauthConsent).set({ scopes: ['agentsplit:read', 'agentsplit:write', 'offline_access'] }).where(eq(oauthConsent.userId, 'alice')))
  })

  it('see membership changes at once', async () => {
    const t = await connect()
    expect((await ok(h, { name: 'get_group', args: { groupId: 'g1' }, headers: bearer(t) }))['group']).toBeDefined()
    expect((await failure(h, { name: 'get_group', args: { groupId: 'g2' }, headers: bearer(t) })).code).toBe('FORBIDDEN')
    await h.withDb((db) => db.update(memberships).set({ active: false }).where(eq(memberships.userId, 'alice')))
    expect((await failure(h, { name: 'get_group', args: { groupId: 'g1' }, headers: bearer(t) })).code).toBe('FORBIDDEN')
    await h.withDb((db) => db.update(memberships).set({ active: true }).where(eq(memberships.userId, 'alice')))
  })

  it('refuse a denied consent without tokens', async () => {
    const a = await authorize({ accept: false, prompt: 'consent' })
    expect(a.error).toBe('access_denied')
    expect(a.code).toBe('')
  })
})

// ---------- DPoP ----------

/** An ES256 DPoP proof signed with WebCrypto (RFC 9449). */
async function dpopKey() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const { kty, crv, x, y } = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  return async (data: { url: string; method?: string; accessToken?: string }) => {
    const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty, crv, x, y } }
    const payload = {
      htm: data.method ?? 'POST',
      htu: data.url,
      iat: Math.floor(Date.now() / 1000),
      jti: random(16),
      ...(data.accessToken ? { ath: await sha256(data.accessToken) } : {}),
    }
    const input = `${b64url(new TextEncoder().encode(JSON.stringify(header)))}.${b64url(new TextEncoder().encode(JSON.stringify(payload)))}`
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input))
    return `${input}.${b64url(signature)}`
  }
}

describe('DPoP-bound tokens', () => {
  it('need the DPoP scheme and a fresh proof, and refuse a replayed proof', async () => {
    const proof = await dpopKey()
    const a = await authorize({})
    const r = await token(
      { grant_type: 'authorization_code', client_id: CLAUDE_CODE, redirect_uri: a.redirectUri, code: a.code, code_verifier: a.verifier },
      { DPoP: await proof({ url: `${BASE}/api/auth/oauth2/token` }) },
    )
    expect(r.status, await r.clone().text()).toBe(200)
    const issued = (await r.json()) as Tokens
    expect(issued.token_type.toLowerCase()).toBe('dpop')
    expect((await rpc(h, { method: 'tools/list', headers: bearer(issued) })).status).toBe(401)
    const headers = { authorization: `DPoP ${issued.access_token}`, DPoP: await proof({ url: MCP_URL, accessToken: issued.access_token }) }
    expect((await rpc(h, { method: 'tools/list', headers })).status).toBe(200)
    expect((await rpc(h, { method: 'tools/list', headers })).status).toBe(401)
    const fresh = { authorization: `DPoP ${issued.access_token}`, DPoP: await proof({ url: MCP_URL, accessToken: issued.access_token }) }
    expect((await rpc(h, { method: 'tools/list', headers: fresh })).status).toBe(200)
    const wrongUrl = { authorization: `DPoP ${issued.access_token}`, DPoP: await proof({ url: `${BASE}/elsewhere`, accessToken: issued.access_token }) }
    expect((await rpc(h, { method: 'tools/list', headers: wrongUrl })).status).toBe(401)
  })

  it('lose their replay rows an hour after the proof expires; other verification rows stay', async () => {
    const row = (data: { id: string; identifier: string; expiredHours: number }) =>
      sql`(${data.id}, ${data.identifier}, 'value', now() - make_interval(hours => ${data.expiredHours}), now(), now())`
    await h.withDb((db) =>
      db.execute(sql`INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at) VALUES
        ${row({ id: 'old-proof', identifier: 'dpop-proof:old', expiredHours: 2 })},
        ${row({ id: 'recent-proof', identifier: 'dpop-proof:recent', expiredHours: 0 })},
        ${row({ id: 'old-other', identifier: 'state:old', expiredHours: 2 })}`),
    )
    expect(await h.withDb((db) => removeExpiredDpopProofs(db))).toBe(1)
    const left = await h.withDb((db) => db.execute<{ id: string }>(sql`SELECT id FROM verification WHERE id IN ('old-proof', 'recent-proof', 'old-other') ORDER BY id`))
    expect(left.rows.map((r) => r.id)).toEqual(['old-other', 'recent-proof'])
  })
})

// ---------- dynamic registration ----------

describe('dynamic client registration', () => {
  it('registers a public native client whose loopback callback works on any port', async () => {
    const r = await h.fetch(
      new Request(`${BASE}/api/auth/oauth2/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Mock agent',
          redirect_uris: ['http://127.0.0.1/callback'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          application_type: 'native',
        }),
      }),
    )
    expect(r.status, await r.clone().text()).toBe(201)
    const client = (await r.json()) as { client_id: string; client_secret?: string }
    expect(client.client_secret).toBeUndefined()
    const t = await connect({ clientId: client.client_id, redirectUri: 'http://127.0.0.1:51234/callback' })
    expect((await ok(h, { name: 'list_groups', headers: bearer(t) }))['groups']).toHaveLength(1)
  })
})

describe('write recheck', () => {
  it('refuses a write whose connection was revoked after authentication', async () => {
    const { assertOAuthWrite } = await import('~/server/auth/oauth-connections')
    const t = await connect()
    const connectionId = (JSON.parse(atob(t.access_token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/') ?? '')) as Record<string, string>)['https://agentsplit.app/connection'] ?? ''
    const principal = { userId: 'alice', name: 'Alice', email: 'alice@example.com', source: 'agent' as const, agentKeyId: `oauth:${connectionId}`, scopes: ['agentsplit:read', 'agentsplit:write'], oauthConnectionId: connectionId }
    await h.withDb((db) => assertOAuthWrite(db, principal))
    await h.withDb((db) => revokeOAuthConnection(db, { userId: 'alice', clientId: CLAUDE_CODE }))
    await expect(h.withDb((db) => assertOAuthWrite(db, principal))).rejects.toThrow('no longer has write permission')
  })
})

// ---------- the OAuth route checks (src/server/oauth-routes.ts) ----------

describe('OAuth routes', () => {
  const revoke = (t: Tokens) =>
    h.fetch(
      new Request(`${BASE}/api/auth/oauth2/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: t.refresh_token ?? '', token_type_hint: 'refresh_token', client_id: CLAUDE_CODE }),
      }),
    )
  const userinfo = (t: Tokens) => h.fetch(new Request(`${BASE}/api/auth/oauth2/userinfo`, { headers: bearer(t) }))

  it('an RFC 7009 revoke of the refresh token stops its access token at once (P-MCP-137)', async () => {
    const t = await connect()
    const other = await connect()
    expect((await rpc(h, { method: 'tools/list', headers: bearer(t) })).status).toBe(200)
    const r = await revoke(t)
    expect(r.status, await r.clone().text()).toBe(200)
    const after = await rpc(h, { method: 'tools/list', headers: bearer(t) })
    expect(after.status).toBe(401)
    expect(after.headers.get('www-authenticate')).toBe(CHALLENGE)
    // Only that grant ends; another connection of the same client keeps working.
    expect((await rpc(h, { method: 'tools/list', headers: bearer(other) })).status).toBe(200)
  })

  it('deleting the consent revokes the connections and refresh tokens of that client (P-MCP-138)', async () => {
    const t = await connect()
    const [consent] = await h.withDb((db) => db.select({ id: oauthConsent.id }).from(oauthConsent).where(and(eq(oauthConsent.userId, 'alice'), eq(oauthConsent.clientId, CLAUDE_CODE))))
    const r = await h.fetch(
      new Request(`${BASE}/api/auth/oauth2/delete-consent`, {
        method: 'POST',
        headers: { cookie: alice.cookie, origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({ id: consent?.id }),
      }),
    )
    expect(r.status, await r.clone().text()).toBe(200)
    expect((await rpc(h, { method: 'tools/list', headers: bearer(t) })).status).toBe(401)
    const refresh = await token({ grant_type: 'refresh_token', client_id: CLAUDE_CODE, refresh_token: t.refresh_token ?? '' })
    expect(refresh.status).toBeGreaterThanOrEqual(400)
    const open = await h.withDb((db) => db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM oauth_connections WHERE user_id = 'alice' AND client_id = ${CLAUDE_CODE} AND revoked_at IS NULL`))
    expect(open.rows[0]?.n).toBe(0)
  })

  it('a consent of someone else cannot be deleted, and revokes nothing (P-MCP-138)', async () => {
    const t = await connect()
    const [consent] = await h.withDb((db) => db.select({ id: oauthConsent.id }).from(oauthConsent).where(and(eq(oauthConsent.userId, 'alice'), eq(oauthConsent.clientId, CLAUDE_CODE))))
    const bob = await h.withDb((db) => db.execute<{ token: string }>(sql`SELECT token FROM session WHERE user_id = 'bob'`)).then((r) => r.rows[0]?.token ?? '')
    const { serializeSignedCookie } = await import('better-call')
    const bobCookie = (await serializeSignedCookie('better-auth.session_token', bob, SECRET)).split(';')[0] ?? ''
    const r = await h.fetch(
      new Request(`${BASE}/api/auth/oauth2/delete-consent`, {
        method: 'POST',
        headers: { cookie: bobCookie, origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({ id: consent?.id }),
      }),
    )
    expect(r.ok).toBe(false)
    expect((await rpc(h, { method: 'tools/list', headers: bearer(t) })).status).toBe(200)
  })

  it('UserInfo applies the MCP checks: a revoked connection gets the 401 challenge (P-MCP-139)', async () => {
    const t = await connect({ scope: `openid email ${ALL}`, prompt: 'consent' })
    const r = await userinfo(t)
    expect(r.status, await r.clone().text()).toBe(200)
    expect(await r.json()).toMatchObject({ sub: 'alice', email: 'alice@example.com' })
    await h.withDb((db) => revokeOAuthConnection(db, { userId: 'alice', clientId: CLAUDE_CODE }))
    const revoked = await userinfo(t)
    expect(revoked.status).toBe(401)
    expect(revoked.headers.get('www-authenticate')).toBe(CHALLENGE)
  })

  it('exports accept the OAuth bearer of a member, and refuse another account’s (P-TOOL-EXPORT-06)', async () => {
    const t = await connect()
    const json = await h.fetch(new Request(`${BASE}/groups/g1/expenses/export/json`, { headers: bearer(t) }))
    expect(json.status).toBe(200)
    expect(((await json.json()) as { id: string }).id).toBe('g1')
    const denied = await h.fetch(new Request(`${BASE}/groups/g2/expenses/export/csv`, { headers: bearer(t) }))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'Group not found, or you are not a member' })
    // Read scope is required: without it the export gets the 403 of the MCP endpoint.
    await h.withDb((db) => db.update(oauthConsent).set({ scopes: ['offline_access'] }).where(eq(oauthConsent.userId, 'alice')))
    const noRead = await h.fetch(new Request(`${BASE}/groups/g1/expenses/export/json`, { headers: bearer(t) }))
    expect(noRead.status).toBe(403)
    expect(await noRead.json()).toEqual({ error: 'Read permission is no longer granted' })
  })
})
