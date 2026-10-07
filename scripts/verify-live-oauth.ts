/** Read-only ledger verification. OAuth discovery may persist public client/JWKS metadata. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { generateKeyPair, SignJWT } from 'jose'
import { z } from 'zod'

const base = 'https://agentsplit.freemanjiang.com'
const resource = `${base}/api/mcp`,
  issuer = `${base}/api/auth`
const credential = z
  .object({ token: z.string() })
  .parse(
    JSON.parse(await readFile('.mcp-credentials/owner-codex.json', 'utf8')),
  )
async function rpc(
  method: string,
  params: Record<string, unknown>,
  keyHeader = 'X-API-Key',
  key = credential.token,
) {
  const r = await fetch(resource, {
    method: 'POST',
    headers: {
      [keyHeader]: keyHeader === 'Authorization' ? `Bearer ${key}` : key,
      'content-type': 'application/json',
      accept: 'application/json,text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await r.text()
  return {
    r,
    data: JSON.parse(
      text
        .split('\n')
        .find((l) => l.startsWith('data: '))
        ?.slice(6) ?? text,
    ),
  }
}
for (const path of [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/api/mcp',
]) {
  const r = await fetch(base + path)
  assert.equal(r.status, 200)
  const m = z
    .object({
      resource: z.string(),
      authorization_servers: z.array(z.string()),
      scopes_supported: z.array(z.string()),
    })
    .parse(await r.json())
  assert.equal(m.resource, resource)
  assert.deepEqual(m.authorization_servers, [issuer])
  assert(m.scopes_supported.includes('agentsplit:read'))
  assert(m.scopes_supported.includes('agentsplit:write'))
}
const r = await fetch(`${base}/.well-known/oauth-authorization-server/api/auth`)
assert.equal(r.status, 200)
const as = z
  .object({
    issuer: z.string(),
    authorization_endpoint: z.string(),
    token_endpoint: z.string(),
    code_challenge_methods_supported: z.array(z.string()),
    client_id_metadata_document_supported: z.boolean(),
    authorization_response_iss_parameter_supported: z.boolean(),
    token_endpoint_auth_methods_supported: z.array(z.string()),
    grant_types_supported: z.array(z.string()),
    registration_endpoint: z.string().optional(),
  })
  .parse(await r.json())
assert.equal(as.issuer, issuer)
assert.equal(as.authorization_endpoint, issuer + '/oauth2/authorize')
assert.equal(as.token_endpoint, issuer + '/oauth2/token')
assert(as.code_challenge_methods_supported.includes('S256'))
assert(as.client_id_metadata_document_supported)
assert(as.authorization_response_iss_parameter_supported)
assert(as.token_endpoint_auth_methods_supported.includes('private_key_jwt'))
assert.equal(as.registration_endpoint, issuer + '/oauth2/register')
for (const method of ['none', 'client_secret_basic', 'client_secret_post'])
  assert(as.token_endpoint_auth_methods_supported.includes(method))
assert(!as.grant_types_supported.includes('client_credentials'))
console.log(
  'PASS live OAuth discovery, PKCE, CIMD, DCR and public/secret/signed client metadata',
)
const unauth = await fetch(resource, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json,text/event-stream',
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  }),
})
assert.equal(unauth.status, 401)
assert(unauth.headers.get('www-authenticate')?.includes('resource_metadata'))
const keys = z
  .object({
    keys: z.array(
      z
        .object({
          kid: z.string(),
          alg: z.string().optional(),
          d: z.unknown().optional(),
          p: z.unknown().optional(),
          q: z.unknown().optional(),
        })
        .passthrough(),
    ),
  })
  .parse(await (await fetch(issuer + '/jwks')).json())
assert(keys.keys.length)
assert(keys.keys.every((k) => !k.d && !k.p && !k.q))
const pair = await generateKeyPair('EdDSA')
const forged = await new SignJWT({
  sub: 'invalid-live-probe',
  scope: 'agentsplit:read',
})
  .setProtectedHeader({ alg: 'EdDSA', kid: keys.keys[0].kid, typ: 'at+jwt' })
  .setIssuer(issuer)
  .setAudience(resource)
  .setIssuedAt()
  .setExpirationTime('1m')
  .sign(pair.privateKey)
assert.equal(
  (await rpc('tools/list', {}, 'Authorization', forged)).r.status,
  401,
)
console.log(
  'PASS public JWKS contains no private material; missing and forged credentials are rejected',
)
const listed = await rpc('tools/list', {})
assert.equal(listed.r.status, 200)
const tools = z
  .object({
    result: z.object({
      tools: z.array(
        z.object({
          name: z.string(),
          securitySchemes: z.array(
            z.object({ type: z.string(), scopes: z.array(z.string()) }),
          ),
          _meta: z.record(z.string(), z.unknown()),
        }),
      ),
    }),
  })
  .parse(listed.data).result.tools
assert.equal(tools.length, 17)
assert(
  tools.every(
    (t) =>
      t.securitySchemes[0].type === 'oauth2' &&
      t.securitySchemes[0].scopes.includes('agentsplit:read'),
  ),
)
for (const header of ['X-API-Key', 'Authorization']) {
  const reply = await rpc(
    'tools/call',
    { name: 'list_groups', arguments: {} },
    header,
  )
  assert.equal(reply.r.status, 200)
  const result = z
    .object({
      result: z.object({
        isError: z.boolean().optional(),
        structuredContent: z.object({
          groups: z.array(z.object({ id: z.string() })),
        }),
      }),
    })
    .parse(reply.data)
  assert(!result.result.isError)
  assert(result.result.structuredContent.groups.length > 0)
}
console.log(
  'PASS all 17 live tools advertise OAuth policy; existing raw and legacy API keys still read authorized groups',
)
const params = new URLSearchParams({
  client_id: 'https://chatgpt.com/oauth/client.json',
  redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
  response_type: 'code',
  scope: 'openid profile email offline_access agentsplit:read agentsplit:write',
  resource,
  code_challenge: 'x'.repeat(43),
  code_challenge_method: 'S256',
  state: 'public-discovery-probe',
})
const authorization = await fetch(issuer + '/oauth2/authorize?' + params, {
  redirect: 'manual',
  headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
})
let redirect = authorization.headers.get('location')
if (authorization.status === 200)
  redirect = z.object({ url: z.string() }).parse(await authorization.json()).url
assert(redirect)
assert.equal(new URL(redirect, base).pathname, '/sign-in')
console.log(
  'PASS the real public ChatGPT CIMD client resolves and reaches sign-in; no user grant or ledger write was performed',
)
