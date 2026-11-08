// OAuth on the MCP endpoint, in process: Better Auth's real authorization
// server and the v2 MCP endpoint on one database. The first block emulates
// Claude Code step by step, as docs/v2/OAUTH-CLAUDE-CODE.md reproduced it.
// Each test connects its own account, because a consent, a revocation or a
// membership change applies to every token of that account.
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { GROUP_DENIED } from '~/shared/errors'
import { expenses, memberships } from '../../db/schema/app'
import { oauthConsent } from '../../db/schema/auth'
import { OAUTH_CONNECTION_CLAIM } from '~/server/auth/constants'
import { assertOAuthWrite, revokeOAuthConnection } from '~/server/auth/oauth-connections'
import { removeExpiredDpopProofs } from '~/server/auth/oauth'
import { mcpExpense } from '../kit/drafts'
import { counter } from '../kit/ids'
import { mcpChallenge, OAUTH_SCOPES } from '../kit/mcp'
import { principal } from '../kit/people'
import { BASE, MCP_URL, startHarness, type Harness } from './harness'

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
const RESOURCE_METADATA = `${BASE}/.well-known/oauth-protected-resource/api/mcp`
const CHALLENGE = mcpChallenge(BASE)
const ALL = OAUTH_SCOPES.join(' ')
/** A group of another account, which no test's account can read. */
const FOREIGN_GROUP = 'g-foreign'

let h: Harness
const realFetch = globalThis.fetch
const nextUser = counter('oauth-user')

/** An account with a web session, admin of its own group of two people. */
type Member = { readonly id: string; readonly cookie: string; readonly groupId: string; readonly participantId: string; readonly otherId: string }

async function member(): Promise<Member> {
  const id = nextUser()
  const { cookie } = await h.account(id, { name: `Name ${id}` })
  const groupId = `g-${id}`
  await h.group({ id: groupId, name: 'Home', people: [`p-${id}`, `q-${id}`], members: [[id, `p-${id}`, 'admin']] })
  return { id, cookie, groupId, participantId: `p-${id}`, otherId: `q-${id}` }
}

beforeAll(async () => {
  h = await startHarness()
  await h.account('stranger')
  await h.group({ id: FOREIGN_GROUP, name: 'Not yours', people: ['ps'], members: [['stranger', 'ps', 'admin']] })
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

/** Authorization of `user` with PKCE (S256) and the resource indicator, through the consent page’s API. */
async function authorize(data: { user: Member; clientId?: string; redirectUri?: string; scope?: string; consentScope?: string; accept?: boolean; prompt?: 'consent' }) {
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
  const { cookie } = data.user
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

async function connect(data: Parameters<typeof authorize>[0]): Promise<Tokens> {
  const a = await authorize(data)
  const r = await token({ grant_type: 'authorization_code', client_id: a.clientId, redirect_uri: a.redirectUri, code: a.code, code_verifier: a.verifier })
  expect(r.status, await r.clone().text()).toBe(200)
  return (await r.json()) as Tokens
}

/** The token endpoint's refusal of a refresh with `t`'s refresh token. */
async function refusedRefresh(t: Tokens) {
  const r = await token({ grant_type: 'refresh_token', client_id: CLAUDE_CODE, refresh_token: t.refresh_token ?? '' })
  return { status: r.status, body: (await r.json()) as { error?: string } }
}

const bearer = (t: Tokens | string) => ({ authorization: `Bearer ${typeof t === 'string' ? t : t.access_token}` })
const expense = (user: Member, title: string) => ({ groupId: user.groupId, expense: mcpExpense({ paidBy: user.participantId, people: [user.participantId, user.otherId], title }) })
const countExpenses = (groupId: string) => h.withDb(async (db) => (await db.select().from(expenses).where(eq(expenses.groupId, groupId))).length)
const setConsent = (user: Member, scopes: string[]) =>
  h.withDb((db) => db.update(oauthConsent).set({ scopes }).where(and(eq(oauthConsent.userId, user.id), eq(oauthConsent.clientId, CLAUDE_CODE))))
/** The ID of `user`'s consent for Claude Code; fails the test when there is none. */
async function consentId(user: Member): Promise<string> {
  const rows = await h.withDb((db) => db.select({ id: oauthConsent.id }).from(oauthConsent).where(and(eq(oauthConsent.userId, user.id), eq(oauthConsent.clientId, CLAUDE_CODE))))
  expect(rows).toHaveLength(1)
  return rows[0]?.id ?? ''
}

// ---------- Claude Code ----------

describe('Claude Code flow emulation', () => {
  // One test: each step uses the tokens and the consent that the steps before it left, as Claude Code does.
  it('challenges, discovers, connects, reads and writes, steps up a read-only grant, and refreshes', async () => {
    const user = await member()
    const initialize = { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.314' } } }

    // 1. An unauthenticated call gets the 401 challenge for read, write and offline_access.
    const unauthenticated = await h.mcp.rpc(initialize)
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.headers.get('www-authenticate')).toBe(CHALLENGE)

    // 2. Discovery lists offline_access and the authorization server, and that server's metadata (RFC 8414) names the endpoints of step 3.
    const resource = await h.fetch(new Request(RESOURCE_METADATA))
    expect(resource.status).toBe(200)
    const meta = (await resource.json()) as { scopes_supported: string[]; authorization_servers: string[] }
    expect(meta.scopes_supported).toEqual([...OAUTH_SCOPES])
    expect(meta.authorization_servers).toEqual([`${BASE}/api/auth`])
    const issuer = new URL(meta.authorization_servers[0] ?? '')
    const server = await h.fetch(new Request(new URL(`/.well-known/oauth-authorization-server${issuer.pathname}`, issuer)))
    expect(server.status).toBe(200)
    const serverMeta = (await server.json()) as Record<string, unknown>
    expect(serverMeta).toMatchObject({
      issuer: `${BASE}/api/auth`,
      authorization_endpoint: `${BASE}/api/auth/oauth2/authorize`,
      token_endpoint: `${BASE}/api/auth/oauth2/token`,
      registration_endpoint: `${BASE}/api/auth/oauth2/register`,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    })
    expect(serverMeta['code_challenge_methods_supported']).toContain('S256')
    expect(serverMeta['token_endpoint_auth_methods_supported']).toEqual(expect.arrayContaining(['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt']))

    // 3. Authorize, consent and token with the challenge’s scope give a write token with a refresh token.
    const tokens = await connect({ user, scope: ALL })
    expect(tokens.scope.split(' ').sort()).toEqual([...OAUTH_SCOPES])
    expect(tokens.refresh_token).toBeTruthy()
    expect(tokens.expires_in).toBe(300)
    expect(tokens).not.toHaveProperty('id_token')

    // 4. Reads and writes work.
    expect((await h.mcp.rpc({ ...initialize, headers: bearer(tokens) })).status).toBe(200)
    const groups = await h.mcp.ok({ name: 'list_groups', headers: bearer(tokens) })
    expect((groups['groups'] as { id: string }[]).map((g) => g.id)).toEqual([user.groupId])
    const created = await h.mcp.ok({ name: 'create_expense', args: expense(user, 'OAuth dinner'), headers: bearer(tokens) })
    expect(created['revision']).toBe(1)
    // The audit row names the OAuth connection.
    const [row] = await h.withDb((db) => db.execute<{ agent_key_id: string; actor_user_id: string }>(sql`SELECT agent_key_id, actor_user_id FROM activities WHERE expense_id = ${created['expenseId'] as string}`)).then((r) => r.rows)
    expect(row?.actor_user_id).toBe(user.id)
    expect(row?.agent_key_id).toMatch(/^oauth:/)

    // 5. A read-only grant gets an HTTP 403 step-up challenge before the write runs, then re-authorizes.
    const readOnly = await connect({ user, scope: ALL, consentScope: 'agentsplit:read offline_access', prompt: 'consent' })
    expect(readOnly.scope.split(' ')).not.toContain('agentsplit:write')
    expect((await h.mcp.callTool({ name: 'list_groups', headers: bearer(readOnly) })).status).toBe(200)
    const before = await countExpenses(user.groupId)
    const blocked = await h.mcp.callTool({ name: 'create_expense', args: expense(user, 'Blocked'), headers: bearer(readOnly) })
    expect(blocked.status).toBe(403)
    expect(blocked.headers.get('www-authenticate')).toBe(`${CHALLENGE}, error="insufficient_scope"`)
    expect(await countExpenses(user.groupId)).toBe(before)
    // The client asks again; this time the user allows changes.
    const upgraded = await connect({ user, scope: ALL })
    expect((await h.mcp.ok({ name: 'create_expense', args: expense(user, 'After step-up'), headers: bearer(upgraded) }))['revision']).toBe(1)

    // 6. After the access token of step 3 expires, a refresh keeps the connection working.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 301_000)
    const expired = await h.mcp.rpc({ method: 'tools/list', headers: bearer(tokens) })
    expect(expired.status).toBe(401)
    expect(expired.headers.get('www-authenticate')).toBe(CHALLENGE)
    const r = await token({ grant_type: 'refresh_token', client_id: CLAUDE_CODE, refresh_token: tokens.refresh_token ?? '' })
    expect(r.status, await r.clone().text()).toBe(200)
    const refreshed = (await r.json()) as Tokens
    expect(refreshed.refresh_token).toBeTruthy()
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token)
    expect((await h.mcp.ok({ name: 'create_expense', args: expense(user, 'After refresh'), headers: bearer(refreshed) }))['revision']).toBe(1)
  })
})

// ---------- discovery ----------

describe('OAuth discovery', () => {
  // The app serves this document itself: Better Auth's version lacks offline_access (src/server/main/app.ts).
  it.each(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp'])('serves %s through the app, on GET and HEAD', async (path) => {
    const response = await h.fetch(new Request(`${BASE}${path}`))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      resource: MCP_URL,
      authorization_servers: [`${BASE}/api/auth`],
      scopes_supported: [...OAUTH_SCOPES],
    })
    expect((await h.fetch(new Request(`${BASE}${path}`, { method: 'HEAD' }))).status).toBe(200)
  })
})

// ---------- token checks ----------

describe('access tokens', () => {
  it('fail closed on a bad signature, an unknown key, a wrong scheme and a missing token', async () => {
    const t = await connect({ user: await member() })
    const [head, body, signature] = t.access_token.split('.')
    const flipped = `${head}.${body}.${signature?.startsWith('A') ? 'B' : 'A'}${signature?.slice(1)}`
    const forged = `${b64url(new TextEncoder().encode(JSON.stringify({ alg: 'ES256', kid: 'nope' })))}.${body}.${random(64)}`
    for (const headers of [bearer(flipped), bearer(forged), { authorization: `Token ${t.access_token}` }, { authorization: 'Bearer ' }]) {
      const r = await h.mcp.rpc({ method: 'tools/list', headers })
      expect(r.status).toBe(401)
      expect(r.headers.get('www-authenticate')).toBe(CHALLENGE)
    }
  })

  it('end with revocation, and revocation leaves API keys working', async () => {
    const user = await member()
    const t = await connect({ user })
    const key = await h.apiKey(user.id)
    expect((await h.mcp.rpc({ method: 'tools/list', headers: bearer(t) })).status).toBe(200)
    await h.withDb((db) => revokeOAuthConnection(db, { userId: user.id, clientId: CLAUDE_CODE }))
    expect((await h.mcp.rpc({ method: 'tools/list', headers: bearer(t) })).status).toBe(401)
    expect(await refusedRefresh(t)).toMatchObject({ status: 400, body: { error: 'invalid_grant' } })
    expect((await h.mcp.rpc({ method: 'tools/list', headers: { 'x-api-key': key } })).status).toBe(200)
    // Reconnecting never revives the old token.
    const again = await connect({ user })
    expect((await h.mcp.rpc({ method: 'tools/list', headers: bearer(again) })).status).toBe(200)
    expect((await h.mcp.rpc({ method: 'tools/list', headers: bearer(t) })).status).toBe(401)
  })

  it('follow the current consent: write removed means step-up, read removed means 403', async () => {
    const user = await member()
    const t = await connect({ user })
    expect((await h.mcp.ok({ name: 'create_expense', args: expense(user, 'Before reduce'), headers: bearer(t) }))['revision']).toBe(1)
    await setConsent(user, ['agentsplit:read', 'offline_access'])
    const write = await h.mcp.callTool({ name: 'create_expense', args: expense(user, 'After reduce'), headers: bearer(t) })
    expect(write.status).toBe(403)
    expect(write.headers.get('www-authenticate')).toContain('error="insufficient_scope"')
    expect((await h.mcp.callTool({ name: 'list_groups', headers: bearer(t) })).status).toBe(200)
    await setConsent(user, ['offline_access'])
    const read = await h.mcp.rpc({ method: 'tools/list', headers: bearer(t) })
    expect(read.status).toBe(403)
    expect(read.body).toEqual({ error: 'Read permission is no longer granted' })
    expect(read.headers.get('www-authenticate')).toBe(`${CHALLENGE}, error="insufficient_scope"`)
  })

  it('see membership changes at once', async () => {
    const user = await member()
    const t = await connect({ user })
    expect((await h.mcp.ok({ name: 'get_group', args: { groupId: user.groupId }, headers: bearer(t) }))['group']).toMatchObject({ id: user.groupId })
    expect((await h.mcp.failure({ name: 'get_group', args: { groupId: FOREIGN_GROUP }, headers: bearer(t) })).code).toBe('FORBIDDEN')
    await h.withDb((db) => db.update(memberships).set({ active: false }).where(eq(memberships.userId, user.id)))
    expect((await h.mcp.failure({ name: 'get_group', args: { groupId: user.groupId }, headers: bearer(t) })).code).toBe('FORBIDDEN')
  })

  it('refuse a denied consent without tokens', async () => {
    const a = await authorize({ user: await member(), accept: false, prompt: 'consent' })
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
    const a = await authorize({ user: await member() })
    const r = await token(
      { grant_type: 'authorization_code', client_id: CLAUDE_CODE, redirect_uri: a.redirectUri, code: a.code, code_verifier: a.verifier },
      { DPoP: await proof({ url: `${BASE}/api/auth/oauth2/token` }) },
    )
    expect(r.status, await r.clone().text()).toBe(200)
    const issued = (await r.json()) as Tokens
    expect(issued.token_type.toLowerCase()).toBe('dpop')
    expect((await h.mcp.rpc({ method: 'tools/list', headers: bearer(issued) })).status).toBe(401)
    const headers = { authorization: `DPoP ${issued.access_token}`, DPoP: await proof({ url: MCP_URL, accessToken: issued.access_token }) }
    expect((await h.mcp.rpc({ method: 'tools/list', headers })).status).toBe(200)
    expect((await h.mcp.rpc({ method: 'tools/list', headers })).status).toBe(401)
    const fresh = { authorization: `DPoP ${issued.access_token}`, DPoP: await proof({ url: MCP_URL, accessToken: issued.access_token }) }
    expect((await h.mcp.rpc({ method: 'tools/list', headers: fresh })).status).toBe(200)
    const wrongUrl = { authorization: `DPoP ${issued.access_token}`, DPoP: await proof({ url: `${BASE}/elsewhere`, accessToken: issued.access_token }) }
    expect((await h.mcp.rpc({ method: 'tools/list', headers: wrongUrl })).status).toBe(401)
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
    const user = await member()
    const t = await connect({ user, clientId: client.client_id, redirectUri: 'http://127.0.0.1:51234/callback' })
    expect(((await h.mcp.ok({ name: 'list_groups', headers: bearer(t) }))['groups'] as { id: string }[]).map((g) => g.id)).toEqual([user.groupId])
  })
})

describe('write recheck', () => {
  it('refuses a write whose connection was revoked after authentication', async () => {
    const user = await member()
    const t = await connect({ user })
    const claims = JSON.parse(atob(t.access_token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/') ?? '')) as Record<string, string>
    const connectionId = claims[OAUTH_CONNECTION_CLAIM] ?? ''
    const agent = { ...principal(user.id, { source: 'agent', agentKeyId: `oauth:${connectionId}` }), scopes: ['agentsplit:read', 'agentsplit:write'], oauthConnectionId: connectionId }
    await h.withDb((db) => assertOAuthWrite(db, agent))
    await h.withDb((db) => revokeOAuthConnection(db, { userId: user.id, clientId: CLAUDE_CODE }))
    await expect(h.withDb((db) => assertOAuthWrite(db, agent))).rejects.toThrow('no longer has write permission')
  })
})

// ---------- the OAuth route checks (src/server/auth/oauth-routes.ts) ----------

describe('OAuth routes', () => {
  const revoke = (t: Tokens) =>
    h.fetch(
      new Request(`${BASE}/api/auth/oauth2/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: t.refresh_token ?? '', token_type_hint: 'refresh_token', client_id: CLAUDE_CODE }),
      }),
    )
  const deleteConsent = (data: { id: string; cookie: string }) =>
    h.fetch(
      new Request(`${BASE}/api/auth/oauth2/delete-consent`, {
        method: 'POST',
        headers: { cookie: data.cookie, origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({ id: data.id }),
      }),
    )
  const userinfo = (t: Tokens) => h.fetch(new Request(`${BASE}/api/auth/oauth2/userinfo`, { headers: bearer(t) }))

  it('an RFC 7009 revoke of the refresh token stops its access token at once (P-MCP-137)', async () => {
    const user = await member()
    const t = await connect({ user })
    const other = await connect({ user })
    expect((await h.mcp.rpc({ method: 'tools/list', headers: bearer(t) })).status).toBe(200)
    const r = await revoke(t)
    expect(r.status, await r.clone().text()).toBe(200)
    const after = await h.mcp.rpc({ method: 'tools/list', headers: bearer(t) })
    expect(after.status).toBe(401)
    expect(after.headers.get('www-authenticate')).toBe(CHALLENGE)
    // Only that grant ends; another connection of the same client keeps working.
    expect((await h.mcp.rpc({ method: 'tools/list', headers: bearer(other) })).status).toBe(200)
  })

  it('deleting the consent revokes the connections and refresh tokens of that client (P-MCP-138)', async () => {
    const user = await member()
    const t = await connect({ user })
    const r = await deleteConsent({ id: await consentId(user), cookie: user.cookie })
    expect(r.status, await r.clone().text()).toBe(200)
    expect((await h.mcp.rpc({ method: 'tools/list', headers: bearer(t) })).status).toBe(401)
    expect(await refusedRefresh(t)).toMatchObject({ status: 400, body: { error: 'invalid_grant' } })
    const open = await h.withDb((db) => db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM oauth_connections WHERE user_id = ${user.id} AND client_id = ${CLAUDE_CODE} AND revoked_at IS NULL`))
    expect(open.rows[0]?.n).toBe(0)
  })

  it('a consent of someone else cannot be deleted, and revokes nothing (P-MCP-138)', async () => {
    const user = await member()
    const t = await connect({ user })
    const id = await consentId(user)
    const intruder = await member()
    // Better Auth answers 401 without a session too, so the intruder's session must be valid.
    const session = await h.fetch(new Request(`${BASE}/api/auth/get-session`, { headers: { cookie: intruder.cookie } }))
    expect(((await session.json()) as { user: { id: string } }).user.id).toBe(intruder.id)
    expect((await deleteConsent({ id, cookie: intruder.cookie })).status).toBe(401)
    expect(await consentId(user)).toBe(id)
    expect((await h.mcp.rpc({ method: 'tools/list', headers: bearer(t) })).status).toBe(200)
  })

  it('UserInfo applies the MCP checks: a revoked connection gets the 401 challenge (P-MCP-139)', async () => {
    const user = await member()
    const t = await connect({ user, scope: `openid email ${ALL}`, prompt: 'consent' })
    const r = await userinfo(t)
    expect(r.status, await r.clone().text()).toBe(200)
    expect(await r.json()).toMatchObject({ sub: user.id, email: `${user.id}@example.com` })
    await h.withDb((db) => revokeOAuthConnection(db, { userId: user.id, clientId: CLAUDE_CODE }))
    const revoked = await userinfo(t)
    expect(revoked.status).toBe(401)
    expect(revoked.headers.get('www-authenticate')).toBe(CHALLENGE)
  })

  it('exports accept the OAuth bearer of a member, and refuse another account’s (P-TOOL-EXPORT-06)', async () => {
    const user = await member()
    const t = await connect({ user })
    const json = await h.fetch(new Request(`${BASE}/groups/${user.groupId}/expenses/export/json`, { headers: bearer(t) }))
    expect(json.status).toBe(200)
    expect(((await json.json()) as { id: string }).id).toBe(user.groupId)
    const denied = await h.fetch(new Request(`${BASE}/groups/${FOREIGN_GROUP}/expenses/export/csv`, { headers: bearer(t) }))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: GROUP_DENIED })
    // Read scope is required: without it the export gets the 403 of the MCP endpoint.
    await setConsent(user, ['offline_access'])
    const noRead = await h.fetch(new Request(`${BASE}/groups/${user.groupId}/expenses/export/json`, { headers: bearer(t) }))
    expect(noRead.status).toBe(403)
    expect(await noRead.json()).toEqual({ error: 'Read permission is no longer granted' })
  })
})
