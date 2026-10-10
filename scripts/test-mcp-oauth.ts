/** Complete HTTP OAuth + MCP flow for a fresh mock agent. Disposable loopback DB only. */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { serializeSignedCookie } from 'better-call'
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { z } from 'zod'
import { GET as authHttp } from '../src/app/api/auth/[...all]/route'
import { POST as revoke } from '../src/app/api/connections/revoke/route'
import { POST as mcp } from '../src/app/api/mcp/route'
import { GET as exportJson } from '../src/app/groups/[groupId]/expenses/export/json/route'
import { getAuth } from '../src/lib/auth'
import { MCP_OUTPUT_SCHEMAS } from '../src/lib/mcp/output-schemas'
import { MCP_TOOL_REGISTRY } from '../src/lib/mcp/registry'
import {
  mcpResource,
  OAUTH_READ_SCOPE,
  OAUTH_WRITE_SCOPE,
  oauthIssuer,
} from '../src/lib/oauth-config'
import { prisma } from '../src/lib/prisma'
import { sessionPrincipal } from '../src/lib/session'
import { appRouter } from '../src/trpc/routers/_app'

const db = new URL(process.env.POSTGRES_PRISMA_URL ?? ''),
  base = process.env.BASE_URL!
assert(
  ['127.0.0.1', 'localhost'].includes(db.hostname) &&
    db.pathname.endsWith('_audit_test'),
)
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
await prisma.rateLimit.deleteMany() // isolated test database only
const auth = getAuth(),
  ctx = await auth.$context,
  suffix = randomBytes(6).toString('hex')
let count = 0
async function check(name: string, f: () => Promise<void>) {
  await f()
  count++
  console.log(`PASS ${name}`)
}
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const request = new Request(new URL(req.url!, base), {
      method: req.method,
      headers: req.headers as Record<string, string>,
      ...(req.method !== 'GET' && req.method !== 'HEAD'
        ? { body: Buffer.concat(chunks) }
        : {}),
    })
    const path = new URL(request.url).pathname
    const response =
      path === '/api/mcp'
        ? await mcp(request)
        : path === '/api/connections/revoke'
          ? await revoke(request)
          : await authHttp(request)
    res.writeHead(response.status, {
      ...Object.fromEntries(response.headers),
      'set-cookie': response.headers.getSetCookie(),
    })
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch (e) {
    console.error(e)
    res.writeHead(500)
    res.end('Test handler failed')
  }
})
await new Promise<void>((resolve) =>
  server.listen(Number(new URL(base).port), '127.0.0.1', resolve),
)
async function identity(label: string) {
  const user = await prisma.user.create({
    data: {
      id: `${label}-${suffix}`,
      name: label,
      email: `${label.toLowerCase()}-${suffix}@example.com`,
      emailVerified: true,
    },
  })
  const session = await ctx.internalAdapter.createSession(user.id)
  const cookie = (
    await serializeSignedCookie(
      ctx.authCookies.sessionToken.name,
      session.token,
      process.env.BETTER_AUTH_SECRET!,
    )
  ).split(';')[0]
  return {
    user,
    headers: { cookie, origin: base, 'content-type': 'application/json' },
  }
}
const alice = await identity('Alice'),
  bob = await identity('Bob')
// A predefined public client models an independent agent without a test auth bypass.
const clientId = `mock-agent-${suffix}`
await prisma.oauthClient.create({
  data: {
    id: clientId,
    clientId,
    name: 'Mock agent ' + suffix,
    redirectUris: ['https://mock-agent.example/callback'],
    tokenEndpointAuthMethod: 'none',
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    requirePKCE: true,
    skipConsent: false,
    scopes: [
      'openid',
      'profile',
      'email',
      'offline_access',
      OAUTH_READ_SCOPE,
      OAUTH_WRITE_SCOPE,
    ],
  },
})
await prisma.oauthClientResource.create({
  data: { id: `${clientId}-resource`, clientId, resourceId: mcpResource() },
})
const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
  token_type: z.string(),
})
const scopes = `openid profile email offline_access ${OAUTH_READ_SCOPE} ${OAUTH_WRITE_SCOPE}`
async function authorize(
  identity = alice,
  requestedScopes = scopes,
  accept = true,
  usingClientId = clientId,
  redirectUri = 'https://mock-agent.example/callback',
) {
  const verifier = randomBytes(32).toString('base64url'),
    state = randomBytes(12).toString('hex')
  const query = new URLSearchParams({
    client_id: usingClientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: requestedScopes,
    resource: mcpResource(),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    prompt: 'consent',
  })
  const response = await fetch(`${base}/api/auth/oauth2/authorize?${query}`, {
    redirect: 'manual',
    headers: { ...identity.headers, accept: 'text/html' },
  })
  assert.equal(
    response.status,
    302,
    `authorize failed: ${await response.clone().text()}`,
  )
  const location = new URL(response.headers.get('location')!, base)
  assert.equal(location.pathname, '/settings/connections/consent')
  const consent = await fetch(`${base}/api/auth/oauth2/consent`, {
    method: 'POST',
    headers: identity.headers,
    body: JSON.stringify({ accept, oauth_query: location.search.slice(1) }),
  })
  assert.equal(
    consent.status,
    200,
    `consent failed: ${await consent.clone().text()}`,
  )
  const target = new URL(
    z.object({ url: z.string() }).parse(await consent.json()).url,
  )
  assert.equal(target.origin, new URL(redirectUri).origin)
  assert.equal(target.searchParams.get('state'), state)
  if (!accept) {
    assert.equal(target.searchParams.get('error'), 'access_denied')
    return { code: '', verifier, query }
  }
  assert(target.searchParams.get('code'))
  return { code: target.searchParams.get('code')!, verifier, query }
}
async function exchange(
  code: string,
  verifier: string,
  extra: Record<string, string> = {},
) {
  return fetch(`${base}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: 'https://mock-agent.example/callback',
      code,
      code_verifier: verifier,
      resource: mcpResource(),
      ...extra,
    }),
  })
}
async function newToken(identity = alice, requestedScopes = scopes) {
  const a = await authorize(identity, requestedScopes)
  const r = await exchange(a.code, a.verifier)
  assert.equal(r.status, 200, `exchange failed: ${await r.clone().text()}`)
  return tokenSchema.parse(await r.json())
}
async function rpc(
  method: string,
  params: Record<string, unknown>,
  token?: string,
  keyHeader = false,
) {
  const r = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json,text/event-stream',
      ...(token
        ? {
            [keyHeader ? 'X-API-Key' : 'Authorization']: keyHeader
              ? token
              : `Bearer ${token}`,
          }
        : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await r.text()
  const decoded = JSON.parse(
    text
      .split('\n')
      .find((l) => l.startsWith('data: '))
      ?.slice(6) ?? text,
  )
  const parsed = z
    .object({
      result: z
        .object({
          isError: z.boolean().optional(),
          _meta: z.record(z.string(), z.unknown()).optional(),
          content: z.unknown().optional(),
          structuredContent: z.unknown().optional(),
          tools: z
            .array(
              z.object({
                name: z.string(),
                securitySchemes: z
                  .array(
                    z.object({ type: z.string(), scopes: z.array(z.string()) }),
                  )
                  .optional(),
              }),
            )
            .optional(),
          serverInfo: z.unknown().optional(),
        })
        .optional(),
    })
    .parse(decoded)
  return { r, body: { result: parsed.result ?? {} } }
}
type ToolName = (typeof MCP_TOOL_REGISTRY)[number]['name']
type ToolOutput<N extends ToolName> = z.output<
  (typeof MCP_OUTPUT_SCHEMAS)[Extract<
    (typeof MCP_TOOL_REGISTRY)[number],
    { name: N }
  >['procedure']]
>
async function call<N extends ToolName>(
  name: N,
  args: Record<string, unknown>,
  token: string,
): Promise<ToolOutput<N>> {
  const result = await rpc('tools/call', { name, arguments: args }, token)
  assert.equal(result.r.status, 200)
  assert(
    !result.body.result.isError,
    JSON.stringify(result.body.result.content),
  )
  const definition = MCP_TOOL_REGISTRY.find((t) => t.name === name)!
  return MCP_OUTPUT_SCHEMAS[definition.procedure].parse(
    result.body.result.structuredContent,
  ) as ToolOutput<N>
}

try {
  await check(
    'discovery advertises CIMD, PKCE S256 and the canonical resource and issuer',
    async () => {
      const resource = z
        .object({
          resource: z.string(),
          authorization_servers: z.array(z.string()),
        })
        .parse(
          await (
            await fetch(`${base}/.well-known/oauth-protected-resource/api/mcp`)
          ).json(),
        )
      assert.equal(resource.resource, mcpResource())
      assert.deepEqual(resource.authorization_servers, [oauthIssuer()])
      const meta = z
        .object({
          issuer: z.string(),
          code_challenge_methods_supported: z.array(z.string()),
          client_id_metadata_document_supported: z.boolean(),
          registration_endpoint: z.string().optional(),
          token_endpoint_auth_methods_supported: z.array(z.string()),
        })
        .parse(
          await (
            await fetch(
              `${base}/.well-known/oauth-authorization-server/api/auth`,
            )
          ).json(),
        )
      assert.equal(meta.issuer, oauthIssuer())
      assert(meta.code_challenge_methods_supported.includes('S256'))
      assert.equal(meta.client_id_metadata_document_supported, true)
      assert.equal(
        meta.registration_endpoint,
        `${base}/api/auth/oauth2/register`,
      )
      for (const method of [
        'none',
        'client_secret_basic',
        'client_secret_post',
        'private_key_jwt',
      ])
        assert(meta.token_endpoint_auth_methods_supported.includes(method))
      const unauth = await rpc('tools/list', {})
      assert.equal(unauth.r.status, 401)
      assert(
        unauth.r.headers.get('www-authenticate')?.includes('resource_metadata'),
      )
    },
  )
  for (const setup of [
    {
      method: 'none',
      redirect: 'https://mock-agent.example/callback',
      native: false,
    },
    {
      method: 'none',
      redirect: 'http://localhost:43119/callback',
      native: true,
    },
    {
      method: 'none',
      redirect: 'http://127.0.0.1:43120/callback',
      native: true,
    },
    {
      method: 'client_secret_post',
      redirect: 'https://mock-agent.example/callback',
      native: false,
    },
    {
      method: 'client_secret_basic',
      redirect: 'https://mock-agent.example/callback',
      native: false,
    },
  ]) {
    await check(
      `DCR ${setup.method} ${new URL(setup.redirect).hostname}: consent, MCP, refresh and revocation`,
      async () => {
        const registration = await fetch(`${base}/api/auth/oauth2/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Deliberately use only standard RFC 7591 fields, without `resources`.
          body: JSON.stringify({
            client_name: `Independent agent ${suffix}`,
            redirect_uris: [
              setup.native
                ? setup.redirect.replace(/:\d+\//, '/')
                : setup.redirect,
            ],
            application_type: setup.native ? 'native' : 'web',
            token_endpoint_auth_method: setup.method,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            scope: scopes,
          }),
        })
        assert.equal(
          registration.status,
          201,
          await registration.clone().text(),
        )
        const registered = z
          .object({
            client_id: z.string(),
            client_secret: z.string().optional(),
          })
          .parse(await registration.json())
        assert.equal(Boolean(registered.client_secret), setup.method !== 'none')
        const stored = await prisma.oauthClient.findUniqueOrThrow({
          where: { clientId: registered.client_id },
        })
        assert(!stored.skipConsent)
        assert.notEqual(stored.requirePKCE, false)
        assert(
          await prisma.oauthClientResource.findFirst({
            where: {
              clientId: registered.client_id,
              resourceId: mcpResource(),
            },
          }),
        )
        async function tokenRequest(
          fields: Record<string, string>,
          wrongSecret = false,
        ) {
          const secret = wrongSecret
            ? 'invalid-secret'
            : registered.client_secret!
          return fetch(`${base}/api/auth/oauth2/token`, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              ...(setup.method === 'client_secret_basic'
                ? {
                    authorization: `Basic ${Buffer.from(`${registered.client_id}:${secret}`).toString('base64')}`,
                  }
                : {}),
            },
            body: new URLSearchParams({
              client_id: registered.client_id,
              ...(setup.method === 'client_secret_post'
                ? { client_secret: secret }
                : {}),
              resource: mcpResource(),
              ...fields,
            }),
          })
        }
        const denied = await authorize(
          alice,
          scopes,
          false,
          registered.client_id,
          setup.redirect,
        )
        assert.equal(denied.code, '')
        const grant = await authorize(
          alice,
          scopes,
          true,
          registered.client_id,
          setup.redirect,
        )
        const fields = {
          grant_type: 'authorization_code',
          code: grant.code,
          code_verifier: grant.verifier,
          redirect_uri: setup.redirect,
        }
        const badProof = await tokenRequest({
          ...fields,
          code_verifier: randomBytes(32).toString('base64url'),
        })
        assert(badProof.status >= 400)
        if (setup.method !== 'none')
          assert((await tokenRequest(fields, true)).status >= 400)
        // Use a fresh code after deliberately rejected exchanges.
        const validGrant = await authorize(
          alice,
          scopes,
          true,
          registered.client_id,
          setup.redirect,
        )
        const exchanged = await tokenRequest({
          ...fields,
          code: validGrant.code,
          code_verifier: validGrant.verifier,
        })
        assert.equal(exchanged.status, 200, await exchanged.clone().text())
        const tokens = tokenSchema.parse(await exchanged.json())
        assert.equal(decodeJwt(tokens.access_token).sub, alice.user.id)
        assert.equal(
          (await rpc('tools/list', {}, tokens.access_token)).r.status,
          200,
        )
        await call('list_groups', {}, tokens.access_token)
        assert(tokens.refresh_token)
        const refreshed = await tokenRequest({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
        })
        assert.equal(refreshed.status, 200, await refreshed.clone().text())
        const rotated = tokenSchema.parse(await refreshed.json())
        assert(
          rotated.refresh_token &&
            rotated.refresh_token !== tokens.refresh_token,
        )
        assert.equal(
          (await rpc('tools/list', {}, rotated.access_token)).r.status,
          200,
        )
        const revoked = await fetch(`${base}/api/connections/revoke`, {
          method: 'POST',
          headers: alice.headers,
          body: JSON.stringify({ clientId: registered.client_id }),
        })
        assert.equal(revoked.status, 200)
        assert.equal(
          (await rpc('tools/list', {}, rotated.access_token)).r.status,
          401,
        )
      },
    )
  }
  await check(
    'DCR rejects unsafe redirects, consent bypass and unsupported grants',
    async () => {
      // The preceding five registrations exhaust the provider's default quota.
      const limited = await fetch(`${base}/api/auth/oauth2/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['https://mock-agent.example/callback'],
        }),
      })
      assert.equal(limited.status, 429)
      await prisma.rateLimit.deleteMany() // reset the isolated test database's quota
      const initialCount = await prisma.oauthClient.count()
      for (const extra of [
        { redirect_uris: ['https://mock-agent.example/callback#fragment'] },
        { redirect_uris: ['http://public-agent.example/callback'] },
        { skip_consent: true },
        { grant_types: ['client_credentials'] },
      ]) {
        const result = await fetch(`${base}/api/auth/oauth2/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_name: 'Invalid client',
            redirect_uris: ['https://mock-agent.example/callback'],
            token_endpoint_auth_method: 'none',
            ...extra,
          }),
        })
        assert.equal(result.status, 400, await result.clone().text())
      }
      assert.equal(await prisma.oauthClient.count(), initialCount)
      await prisma.rateLimit.deleteMany()
    },
  )
  await check(
    'logged-out authorization preserves signed context on the Google sign-in page',
    async () => {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: 'https://mock-agent.example/callback',
        response_type: 'code',
        scope: scopes,
        resource: mcpResource(),
        code_challenge: randomBytes(32).toString('base64url'),
        code_challenge_method: 'S256',
      })
      const r = await fetch(`${base}/api/auth/oauth2/authorize?${q}`, {
        redirect: 'manual',
        headers: { accept: 'text/html' },
      })
      assert.equal(r.status, 302)
      const u = new URL(r.headers.get('location')!, base)
      assert.equal(u.pathname, '/sign-in')
      assert(u.searchParams.get('sig'))
      assert.equal(u.searchParams.get('client_id'), clientId)
    },
  )
  await check(
    'consent denial returns access_denied and issues no tokens',
    async () => {
      const before = await prisma.oauthRefreshToken.count()
      await authorize(alice, scopes, false)
      assert.equal(await prisma.oauthRefreshToken.count(), before)
    },
  )
  await check(
    'missing PKCE and a mismatched verifier are rejected',
    async () => {
      const a = await authorize()
      const wrong = await exchange(
        a.code,
        randomBytes(32).toString('base64url'),
      )
      assert(wrong.status >= 400)
      const q = new URLSearchParams(a.query)
      q.delete('code_challenge')
      q.delete('code_challenge_method')
      const r = await fetch(`${base}/api/auth/oauth2/authorize?${q}`, {
        redirect: 'manual',
        headers: alice.headers,
      })
      const data = await r.text()
      assert(
        r.status >= 400 ||
          data.includes('error') ||
          r.headers.get('location')?.includes('error='),
      )
    },
  )
  const readOnly = await newToken(
    alice,
    `openid profile email offline_access ${OAUTH_READ_SCOPE}`,
  )
  const full = await newToken()
  await check(
    'code exchange produces resource-bound short-lived tokens without Google credentials',
    async () => {
      const claims = decodeJwt(full.access_token)
      assert.equal(claims.sub, alice.user.id)
      assert.deepEqual(claims.aud, [
        mcpResource(),
        `${oauthIssuer()}/oauth2/userinfo`,
      ])
      assert.equal(claims.iss, oauthIssuer())
      assert.equal(full.expires_in, 300)
      assert(full.refresh_token)
      assert(!('idToken' in full))
    },
  )
  let groupId = '',
    expenseId = '',
    participantId = ''
  await check(
    'new mock agent initializes, lists tools, creates a group and records a payment with actual actor attribution',
    async () => {
      const init = await rpc(
        'initialize',
        {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'mock-new-agent', version: '1.0.0' },
        },
        full.access_token,
      )
      assert.equal(init.r.status, 200)
      assert(init.body.result.serverInfo)
      const tools = (await rpc('tools/list', {}, full.access_token)).body.result
        .tools!
      assert.equal(tools.length, 20)
      assert.deepEqual(
        tools.find((t: { name: string }) => t.name === 'create_expense')!
          .securitySchemes,
        [{ type: 'oauth2', scopes: [OAUTH_READ_SCOPE, OAUTH_WRITE_SCOPE] }],
      )
      const made = await call(
        'create_group',
        {
          group: {
            name: `OAuth trip ${suffix}`,
            currency: '$',
            currencyCode: 'USD',
            participants: [{ name: 'Bob' }],
          },
        },
        full.access_token,
      )
      groupId = made.groupId
      participantId = made.group.participants.find(
        (p: { name: string }) => p.name === 'Alice',
      )!.id
      const other = made.group.participants.find(
        (p: { name: string }) => p.name === 'Bob',
      )!.id
      const e = await call(
        'create_expense',
        {
          groupId,
          expense: {
            title: 'Mock payment',
            amount: '12.34',
            currencyCode: 'USD',
            expenseDate: '2026-10-07',
            paidBy: other,
            paidFor: [{ participant: participantId, shares: '1' }],
            splitMode: 'EVENLY',
            isReimbursement: true,
          },
        },
        full.access_token,
      )
      expenseId = e.expenseId
      const saved = await call(
        'get_expense',
        { groupId, expenseId },
        full.access_token,
      )
      assert.equal(saved.expense.paidById, other)
      assert.equal(saved.expense.attribution.createdBy?.userId, alice.user.id)
      assert.equal(saved.expense.amount, '12.34')
    },
  )
  await check(
    'read-only grant reads the same group but cannot write through MCP or underlying tRPC',
    async () => {
      await call('get_group', { groupId }, readOnly.access_token)
      const denied = await rpc(
        'tools/call',
        {
          name: 'update_expense',
          arguments: {
            groupId,
            expenseId,
            expectedRevision: 1,
            changes: { title: 'Must not save' },
          },
        },
        readOnly.access_token,
      )
      assert.equal(denied.r.status, 200)
      assert.equal(denied.body.result.isError, true)
      assert(
        JSON.stringify(denied.body.result._meta).includes('insufficient_scope'),
      )
      const principal = (await sessionPrincipal(new Headers(alice.headers)))!
      await assert.rejects(
        () =>
          appRouter
            .createCaller({
              principal: { ...principal, scopes: [OAUTH_READ_SCOPE] },
            })
            .groups.expenses.delete({
              groupId,
              expenseId,
              expectedRevision: 1,
            }),
        /not been granted/,
      )
      assert.equal(
        (await prisma.expense.findUniqueOrThrow({ where: { id: expenseId } }))
          .revision,
        1,
      )
    },
  )
  await check(
    'OAuth agents can create ungrouped expenses and update their own profile; read-only grants cannot',
    async () => {
      const args = {
        people: [
          { kind: 'account', id: 'me', userId: alice.user.id },
          {
            kind: 'email',
            id: 'guest',
            name: 'Guest',
            email: `guest-${suffix}@example.com`,
          },
        ],
        expense: {
          title: 'OAuth private dinner',
          amount: '20',
          currencyCode: 'USD',
          expenseDate: '2026-10-09',
          paidBy: 'me',
          paidFor: [
            { participant: 'me', shares: '1' },
            { participant: 'guest', shares: '1' },
          ],
          isReimbursement: false,
        },
      }
      for (const [name, argumentsValue] of [
        ['create_expense', args],
        ['update_profile', { name: alice.user.name }],
      ] as const) {
        const denied = await rpc(
          'tools/call',
          { name, arguments: argumentsValue },
          readOnly.access_token,
        )
        assert.equal(denied.body.result.isError, true)
      }
      const privateExpense = await call(
        'create_expense',
        args,
        full.access_token,
      )
      assert(privateExpense.groupId)
      assert.equal(privateExpense.invitations?.length, 1)
      const renamed = await call(
        'update_profile',
        { name: alice.user.name },
        full.access_token,
      )
      assert.equal(renamed.profile.id, alice.user.id)
      const visible = await call(
        'list_all_expenses',
        { scope: 'ungrouped' },
        readOnly.access_token,
      )
      assert(
        visible.expenses.some(
          (expense) => expense.id === privateExpense.expenseId,
        ),
      )
    },
  )
  await check(
    'another authenticated OAuth account cannot read the group or export it',
    async () => {
      const other = await newToken(bob)
      const result = await rpc(
        'tools/call',
        { name: 'get_group', arguments: { groupId } },
        other.access_token,
      )
      assert.equal(result.body.result.isError, true)
      const response = await exportJson(
        new Request(`${base}/groups/${groupId}/expenses/export/json`, {
          headers: { Authorization: `Bearer ${other.access_token}` },
        }),
        { params: Promise.resolve({ groupId }) },
      )
      assert.equal(response.status, 403)
    },
  )
  await check(
    'OAuth works on the authorized export path as well as the MCP export tool',
    async () => {
      const response = await exportJson(
        new Request(`${base}/groups/${groupId}/expenses/export/json`, {
          headers: { Authorization: `Bearer ${full.access_token}` },
        }),
        { params: Promise.resolve({ groupId }) },
      )
      assert.equal(response.status, 200)
      assert((await response.text()).includes('Mock payment'))
      const exported = await call(
        'export_group',
        { groupId, format: 'json' },
        full.access_token,
      )
      assert(exported.content.includes('Mock payment'))
    },
  )
  await check(
    'wrong signature, audience, issuer and expired tokens fail closed',
    async () => {
      const claims = decodeJwt(full.access_token)
      const control = await auth.api.signJWT({ body: { payload: claims } })
      assert.equal(
        (await rpc('tools/list', {}, control.token)).r.status,
        200,
        'Control token must be valid before testing claim constraints',
      )
      const fake = await generateKeyPair('ES256')
      const forged = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt' })
        .sign(fake.privateKey)
      assert.equal((await rpc('tools/list', {}, forged)).r.status, 401)
      for (const overrides of [
        { aud: 'https://other.example/mcp' },
        { iss: 'https://other.example/auth' },
        { exp: 1 },
      ]) {
        const signed = await auth.api.signJWT({
          body: { payload: { ...claims, ...overrides } },
        })
        assert.equal((await rpc('tools/list', {}, signed.token)).r.status, 401)
      }
    },
  )
  let refreshed: z.infer<typeof tokenSchema> = full
  await check(
    'refresh rotates the token and retains the same stable account and connection',
    async () => {
      const r = await fetch(`${base}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: full.refresh_token!,
          resource: mcpResource(),
        }),
      })
      assert.equal(r.status, 200, await r.clone().text())
      refreshed = tokenSchema.parse(await r.json())
      assert.notEqual(refreshed.refresh_token, full.refresh_token)
      assert.equal(decodeJwt(refreshed.access_token).sub, alice.user.id)
      await call('get_group', { groupId }, refreshed.access_token)
    },
  )
  await check(
    'modern stateless MCP requests work alongside legacy clients',
    async () => {
      const r = await fetch(`${base}/api/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${full.access_token}`,
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/list',
          'content-type': 'application/json',
          accept: 'application/json,text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': {
                name: 'mock-modern-agent',
                version: '1.0',
              },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      })
      assert.equal(r.status, 200, await r.text())
    },
  )
  await check(
    'reducing current consent immediately removes write access from older tokens',
    async () => {
      await newToken(
        alice,
        `openid profile email offline_access ${OAUTH_READ_SCOPE}`,
      )
      const denied = await rpc(
        'tools/call',
        {
          name: 'update_expense',
          arguments: {
            groupId,
            expenseId,
            expectedRevision: 1,
            changes: { title: 'Not authorized' },
          },
        },
        full.access_token,
      )
      assert.equal(denied.body.result.isError, true)
      await newToken()
    },
  )
  await check(
    'membership removal immediately blocks already-issued OAuth tokens',
    async () => {
      await prisma.userGroupAccess.update({
        where: { userId_groupId: { userId: alice.user.id, groupId } },
        data: { active: false },
      })
      const denied = await rpc(
        'tools/call',
        { name: 'get_group', arguments: { groupId } },
        full.access_token,
      )
      assert.equal(denied.body.result.isError, true)
      await prisma.userGroupAccess.update({
        where: { userId_groupId: { userId: alice.user.id, groupId } },
        data: { active: true },
      })
    },
  )
  const key = await auth.api.createApiKey({
    headers: new Headers(alice.headers),
    body: { name: 'OAuth regression test' },
  })
  await check(
    'connection revocation stops access and refresh tokens immediately without revoking API keys',
    async () => {
      const r = await fetch(`${base}/api/connections/revoke`, {
        method: 'POST',
        headers: alice.headers,
        body: JSON.stringify({ clientId }),
      })
      assert.equal(r.status, 200)
      assert.equal(
        (await rpc('tools/list', {}, full.access_token)).r.status,
        401,
      )
      assert.equal(
        (await rpc('tools/list', {}, refreshed.access_token)).r.status,
        401,
      )
      assert.equal(
        (
          await fetch(`${base}/api/auth/oauth2/userinfo`, {
            headers: { Authorization: `Bearer ${full.access_token}` },
          })
        ).status,
        401,
      )
      const refresh = await fetch(`${base}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: refreshed.refresh_token!,
          resource: mcpResource(),
        }),
      })
      assert(refresh.status >= 400)
      for (const direct of [true, false]) {
        const response = await rpc(
          'tools/call',
          { name: 'get_group', arguments: { groupId } },
          key.key,
          direct,
        )
        assert.equal(response.r.status, 200)
        assert(!response.body.result.isError)
      }
    },
  )
  await check('reconnecting never revives an old access token', async () => {
    const again = await newToken()
    await call('get_group', { groupId }, again.access_token)
    assert.equal((await rpc('tools/list', {}, full.access_token)).r.status, 401)
  })
  await check(
    'standard refresh-token revocation also invalidates its existing access JWT',
    async () => {
      const tokens = await newToken()
      const r = await fetch(`${base}/api/auth/oauth2/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          token: tokens.refresh_token!,
          token_type_hint: 'refresh_token',
        }),
      })
      assert.equal(r.status, 200, await r.text())
      assert.equal(
        (await rpc('tools/list', {}, tokens.access_token)).r.status,
        401,
      )
    },
  )
  await check(
    'provider consent deletion revokes old grants and reconnect cannot revive them',
    async () => {
      const tokens = await newToken()
      const consent = await prisma.oauthConsent.findFirstOrThrow({
        where: { userId: alice.user.id, clientId },
      })
      const r = await fetch(`${base}/api/auth/oauth2/delete-consent`, {
        method: 'POST',
        headers: alice.headers,
        body: JSON.stringify({ id: consent.id }),
      })
      assert.equal(r.status, 200, await r.text())
      await newToken()
      assert.equal(
        (await rpc('tools/list', {}, tokens.access_token)).r.status,
        401,
      )
    },
  )
  await check(
    'fresh signed client authenticates with private_key_jwt and PKCE',
    async () => {
      const pair = await generateKeyPair('RS256'),
        signedClient = `signed-agent-${suffix}`,
        kid = `signed-${suffix}`
      const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: 'RS256' }
      await prisma.oauthClient.create({
        data: {
          id: signedClient,
          clientId: signedClient,
          name: 'Signed mock agent',
          redirectUris: ['https://mock-agent.example/callback'],
          tokenEndpointAuthMethod: 'private_key_jwt',
          grantTypes: ['authorization_code', 'refresh_token'],
          responseTypes: ['code'],
          requirePKCE: true,
          skipConsent: false,
          jwks: JSON.stringify({ keys: [jwk] }),
          scopes: scopes.split(' '),
        },
      })
      await prisma.oauthClientResource.create({
        data: {
          id: `${signedClient}-resource`,
          clientId: signedClient,
          resourceId: mcpResource(),
        },
      })
      const a = await authorize(alice, scopes, true, signedClient)
      const assertion = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(signedClient)
        .setSubject(signedClient)
        .setAudience(`${base}/api/auth/oauth2/token`)
        .setIssuedAt()
        .setExpirationTime('60s')
        .setJti(randomBytes(16).toString('hex'))
        .sign(pair.privateKey)
      const r = await exchange(a.code, a.verifier, {
        client_id: signedClient,
        client_assertion_type:
          'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
      })
      assert.equal(r.status, 200, await r.clone().text())
      const tokens = tokenSchema.parse(await r.json())
      await call('get_group', { groupId }, tokens.access_token)
      const second = await authorize(alice, scopes, true, signedClient)
      const replay = await exchange(second.code, second.verifier, {
        client_id: signedClient,
        client_assertion_type:
          'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
      })
      assert(replay.status >= 400)
    },
  )
  await check(
    'Google sign-in callback resumes OAuth consent without passing Google tokens to the agent',
    async () => {
      const nativeFetch = globalThis.fetch,
        pair = await generateKeyPair('RS256'),
        kid = `mock-google-${suffix}`,
        email = `google-${suffix}@example.com`
      let nonce = ''
      const jwk = {
        ...(await exportJWK(pair.publicKey)),
        kid,
        alg: 'RS256',
        use: 'sig',
      }
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        if (url === 'https://www.googleapis.com/oauth2/v3/certs')
          return Response.json({ keys: [jwk] })
        if (url === 'https://oauth2.googleapis.com/token') {
          const token = await new SignJWT({
            email,
            email_verified: true,
            name: 'Mock Google User',
            ...(nonce ? { nonce } : {}),
          })
            .setProtectedHeader({ alg: 'RS256', kid })
            .setIssuer('https://accounts.google.com')
            .setSubject(`mock-google-sub-${suffix}`)
            .setAudience(process.env.GOOGLE_CLIENT_ID!)
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(pair.privateKey)
          return Response.json({
            access_token: 'mock-google-access-never-shared',
            refresh_token: 'mock-google-refresh-never-shared',
            id_token: token,
            expires_in: 3600,
            scope: 'openid email profile',
            token_type: 'Bearer',
          })
        }
        return nativeFetch(input, init)
      }) as typeof fetch
      try {
        const verifier = randomBytes(32).toString('base64url'),
          state = randomBytes(16).toString('hex')
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: 'https://mock-agent.example/callback',
          response_type: 'code',
          scope: scopes,
          resource: mcpResource(),
          code_challenge: createHash('sha256')
            .update(verifier)
            .digest('base64url'),
          code_challenge_method: 'S256',
          state,
          prompt: 'consent',
        })
        const start = await fetch(
          `${base}/api/auth/oauth2/authorize?${params}`,
          { redirect: 'manual', headers: { accept: 'text/html' } },
        )
        assert.equal(start.status, 302)
        const login = new URL(start.headers.get('location')!, base)
        const signIn = await fetch(`${base}/api/auth/sign-in/social`, {
          method: 'POST',
          headers: { origin: base, 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: 'google',
            callbackURL: '/groups',
            oauth_query: login.search.slice(1),
          }),
        })
        assert.equal(signIn.status, 200, await signIn.clone().text())
        const google = new URL(
          z.object({ url: z.string() }).parse(await signIn.json()).url,
        )
        nonce = google.searchParams.get('nonce') ?? ''
        const cookie = signIn.headers
          .getSetCookie()
          .map((c) => c.split(';')[0])
          .join('; ')
        const callback = await fetch(
          `${base}/api/auth/callback/google?${new URLSearchParams({ code: 'mock-google-code', state: google.searchParams.get('state')! })}`,
          { redirect: 'manual', headers: { cookie, accept: 'text/html' } },
        )
        assert.equal(callback.status, 302)
        const consentLocation = new URL(callback.headers.get('location')!, base)
        assert.equal(
          consentLocation.pathname,
          '/settings/connections/consent',
          consentLocation.href,
        )
        const sessionCookie = callback.headers
          .getSetCookie()
          .map((c) => c.split(';')[0])
          .join('; ')
        const consent = await fetch(`${base}/api/auth/oauth2/consent`, {
          method: 'POST',
          headers: {
            cookie: sessionCookie,
            origin: base,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            accept: true,
            oauth_query: consentLocation.search.slice(1),
          }),
        })
        assert.equal(consent.status, 200, await consent.clone().text())
        const target = new URL(
          z.object({ url: z.string() }).parse(await consent.json()).url,
        )
        assert.equal(target.searchParams.get('state'), state)
        const exchangeResponse = await exchange(
          target.searchParams.get('code')!,
          verifier,
        )
        assert.equal(
          exchangeResponse.status,
          200,
          await exchangeResponse.clone().text(),
        )
        const raw = await exchangeResponse.text()
        assert(!raw.includes('mock-google-access'))
        assert(!raw.includes('mock-google-refresh'))
        const tokens = tokenSchema.parse(JSON.parse(raw))
        const user = await prisma.user.findUniqueOrThrow({ where: { email } })
        assert(user.emailVerified)
        assert.equal(decodeJwt(tokens.access_token).sub, user.id)
        assert.equal(
          (await call('list_groups', {}, tokens.access_token)).groups.length,
          0,
        )
      } finally {
        globalThis.fetch = nativeFetch
      }
    },
  )
  await check(
    'DPoP-bound tokens require the correct proof and reject proof replay',
    async () => {
      const pair = await generateKeyPair('ES256'),
        jwk = await exportJWK(pair.publicKey)
      async function proof(url: string, accessToken?: string) {
        return new SignJWT({
          htm: 'POST',
          htu: url,
          ...(accessToken
            ? {
                ath: createHash('sha256')
                  .update(accessToken)
                  .digest('base64url'),
              }
            : {}),
        })
          .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk })
          .setIssuedAt()
          .setJti(randomBytes(16).toString('hex'))
          .sign(pair.privateKey)
      }
      const a = await authorize()
      const token = await fetch(`${base}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          DPoP: await proof(`${base}/api/auth/oauth2/token`),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          redirect_uri: 'https://mock-agent.example/callback',
          code: a.code,
          code_verifier: a.verifier,
          resource: mcpResource(),
        }),
      })
      assert.equal(token.status, 200, await token.clone().text())
      const issued = tokenSchema.parse(await token.json())
      assert.equal(issued.token_type.toLowerCase(), 'dpop')
      assert.equal(
        (await rpc('tools/list', {}, issued.access_token)).r.status,
        401,
      )
      const headers = {
        Authorization: `DPoP ${issued.access_token}`,
        DPoP: await proof(`${base}/api/mcp`, issued.access_token),
        'content-type': 'application/json',
        accept: 'application/json,text/event-stream',
      }
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      })
      const valid = await fetch(`${base}/api/mcp`, {
        method: 'POST',
        headers,
        body,
      })
      assert.equal(valid.status, 200, await valid.text())
      const replay = await fetch(`${base}/api/mcp`, {
        method: 'POST',
        headers,
        body,
      })
      assert.equal(replay.status, 401)
    },
  )
  console.log(`${count} complete HTTP OAuth/MCP scenarios passed`)
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await prisma.$disconnect()
}
