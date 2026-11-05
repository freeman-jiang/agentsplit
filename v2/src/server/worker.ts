import { env } from 'cloudflare:workers'
import { Layer, Scheduler } from 'effect'
import { HttpRouter } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import pg from 'pg'
import { makeDb, registerRequestDb, releaseRequestDb, REQUEST_ID_HEADER, type Db } from './db'
import type { Env } from './env'
import { HandlersLive } from './handlers'
import { Api, AppConfig, AuthMiddlewareLive } from './rpc'
import { Forbidden } from '../shared/api'
import { livenessResponse, readinessResponse, robotsTxt, secured, sitemapXml } from './security'
import { sessionPrincipal } from './session'

const appEnv = env as unknown as Env
const config = {
  baseUrl: appEnv.BASE_URL,
  secret: appEnv.BETTER_AUTH_SECRET,
  googleClientId: appEnv.GOOGLE_CLIENT_ID,
  googleClientSecret: appEnv.GOOGLE_CLIENT_SECRET,
  documentsEnabled: /^(true|yes|1|on)$/i.test(appEnv.ENABLE_EXPENSE_DOCUMENTS ?? ''),
}

// Built once, at module scope, as Effect requires on Workers: the RPC server's
// shared fiber must not belong to any one request. The sync scheduler runs
// shared fibers without timers. Per-request state (the database connection)
// arrives in each request's context instead.
const SyncScheduler = Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler('sync'))
const rpcHandler = HttpRouter.toWebHandler(
  RpcServer.layerHttp({ group: Api, path: '/api/rpc', protocol: 'http' }).pipe(
    Layer.provide(HandlersLive),
    Layer.provide(AuthMiddlewareLive),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(Layer.succeed(AppConfig, config)),
    Layer.provideMerge(SyncScheduler),
  ),
).handler

/** The signed-in web user of a plain HTTP request, from the session cookie. */
async function principalOf(db: Db, request: Request) {
  const { sessionPrincipal } = await import('./session')
  return sessionPrincipal(db, { cookie: request.headers.get('cookie'), secret: config.secret, baseUrl: config.baseUrl })
}

/**
 * Runs `work` with one database connection for this request, and closes it
 * after the response body is complete. Hyperdrive pools the real connections.
 */
async function withConnection(work: (client: pg.Client) => Promise<Response>, cacheControl = 'no-store'): Promise<Response> {
  const client = new pg.Client({ connectionString: appEnv.HYPERDRIVE.connectionString })
  await client.connect()
  try {
    const response = await work(client)
    const body = await response.arrayBuffer()
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', cacheControl)
    return new Response(body, { status: response.status, statusText: response.statusText, headers })
  } finally {
    await client.end().catch(() => {})
  }
}

/** Better Auth, loaded only for its own routes, so RPC requests never parse it. */
async function authHandler(request: Request): Promise<Response> {
  try {
    return await withConnection(async (client) =>
      (await import('./auth')).createAuth({ ...config, bootstrapEmail: appEnv.AUTH_BOOTSTRAP_EMAIL, db: makeDb(client) }).handler(request),
    )
  } catch (error) {
    // Better Auth answers client errors itself (4xx). Only a real failure gets here.
    console.error('Auth handler failed', error)
    return Response.json({ error: 'Sign-in is temporarily unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}

/** SELECT 1 on a connection of its own, so a failed connect is reported as unhealthy too. */
async function checkDatabase() {
  const client = new pg.Client({ connectionString: appEnv.HYPERDRIVE.connectionString })
  await client.connect()
  try {
    await client.query('SELECT 1')
  } finally {
    await client.end().catch(() => {})
  }
}

/** CSV and JSON exports, at the current app's URLs: /groups/<id>/expenses/export/<format> and /<slug>/expenses/export/<format>. */
async function exportGroup(data: { db: ReturnType<typeof makeDb>; cookie: string | null; group: string; format: 'csv' | 'json' }) {
  let group: string
  try {
    group = decodeURIComponent(data.group)
  } catch {
    return Response.json({ error: 'Invalid group ID' }, { status: 404 })
  }
  const principal = await sessionPrincipal(data.db, { cookie: data.cookie, secret: config.secret, baseUrl: config.baseUrl })
  if (!principal) return Response.json({ error: 'Sign in required' }, { status: 401 })
  const { exportCsv, exportJson, exportResponse } = await import('./export')
  try {
    return exportResponse(await (data.format === 'json' ? exportJson : exportCsv)(data.db, { principal, group }))
  } catch (error) {
    if (error instanceof Forbidden) return Response.json({ error: 'Group access denied' }, { status: 403 })
    throw error
  }
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url)
  // The Effect RPC client joins its base URL with a slash, so it posts to /api/rpc/.
  if (url.pathname === '/api/rpc' || url.pathname === '/api/rpc/') {
    // The session cookie alone must not authorize a cross-site write.
    if (request.method === 'POST' && request.headers.get('origin') !== new URL(config.baseUrl).origin)
      return Response.json({ error: 'Origin not allowed' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
    url.pathname = '/api/rpc'
    // Only the Worker sets this header: it names the connection the middleware uses.
    const id = crypto.randomUUID()
    const headers = new Headers(request.headers)
    headers.set(REQUEST_ID_HEADER, id)
    const rpcRequest = new Request(url, { method: request.method, headers, body: request.body })
    return withConnection(async (client) => {
      registerRequestDb(id, makeDb(client))
      try {
        return await rpcHandler(rpcRequest)
      } finally {
        releaseRequestDb(id)
      }
    }, 'private, no-store')
  }
  // The MCP endpoint and its auth load only for this route.
  if (url.pathname === '/api/mcp')
    return withConnection(async (client) => (await import('./mcp/endpoint')).handleMcp(request, { db: makeDb(client), baseUrl: config.baseUrl }))
  // The Worker serves the protected-resource metadata itself: Better Auth's MCP plugin drops
  // offline_access from it, which left Claude Code without refresh tokens (OAUTH-CLAUDE-CODE.md).
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    const mcp = await import('./mcp/challenge')
    if (mcp.METADATA_PATHS.has(url.pathname)) return mcp.protectedResourceMetadata(request, config.baseUrl)
  }
  // OAuth discovery: Better Auth serves the authorization-server metadata.
  if (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/.well-known/')) return authHandler(request)
  if (url.pathname === '/api/health' || url.pathname === '/api/health/readiness') return readinessResponse(checkDatabase)
  if (url.pathname === '/api/health/liveness') return livenessResponse()
  if (url.pathname === '/robots.txt') return robotsTxt(config.baseUrl)
  if (url.pathname === '/sitemap.xml') return sitemapXml(config.baseUrl)
  if (url.pathname === '/api/receipts') {
    if (request.method !== 'GET' && request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 })
    // An upload is a cookie-authenticated write: refuse other origins, as for RPC.
    if (request.method === 'POST' && request.headers.get('origin') !== new URL(config.baseUrl).origin)
      return Response.json({ error: 'Origin not allowed' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
    // Not withConnection: the image streams from R2 after the database work is done, with its own headers.
    const client = new pg.Client({ connectionString: appEnv.HYPERDRIVE.connectionString })
    await client.connect()
    try {
      const db = makeDb(client)
      const { downloadReceipt, uploadReceipt } = await import('./receipts')
      const principal = await principalOf(db, request)
      return await (request.method === 'GET'
        ? downloadReceipt({ db, bucket: appEnv.RECEIPTS, principal, url })
        : uploadReceipt({ db, bucket: appEnv.RECEIPTS, principal, request, baseUrl: config.baseUrl, enabled: config.documentsEnabled }))
    } finally {
      await client.end().catch(() => {})
    }
  }
  const exportRoute = /^\/(?:groups\/)?([^/]+)\/expenses\/export\/(csv|json)$/.exec(url.pathname)
  if (exportRoute && request.method === 'GET') {
    const [, group = '', format] = exportRoute
    // Downloads stay out of shared caches, as in the current app.
    return withConnection(
      (client) => exportGroup({ db: makeDb(client), cookie: request.headers.get('cookie'), group, format: format === 'json' ? 'json' : 'csv' }),
      'private, no-store',
    )
  }
  // The current app's presigned upload route is gone for good (P-RECEIPT-28).
  if (url.pathname === '/api/s3-upload')
    return Response.json({ error: 'Use the authenticated receipt upload flow' }, { status: 410, headers: { 'Cache-Control': 'no-store' } })
  if (url.pathname.startsWith('/api/')) return Response.json({ error: 'Not found' }, { status: 404 })
  return appEnv.ASSETS.fetch(request)
}

export default {
  async fetch(request) {
    return secured(await route(request))
  },
  /**
   * The cron trigger in wrangler.jsonc. It creates due recurring expenses, so
   * reads never have to (DECISIONS.md, P-BAL-30 and P-RECUR-08). A failed
   * occurrence is logged and retried on the next run.
   */
  async scheduled(controller) {
    const client = new pg.Client({ connectionString: appEnv.HYPERDRIVE.connectionString })
    await client.connect()
    try {
      const db = makeDb(client)
      const { materializeDue } = await import('./recurring')
      const created = await materializeDue({
        today: new Date(controller.scheduledTime).toISOString().slice(0, 10),
        transaction: (work) => db.transaction(work, { isolationLevel: 'serializable' }),
        onError: (error) => console.error('Recurring expense failed', error),
      })
      if (created.length) console.log(`Created ${created.length} recurring expenses`)
    } finally {
      await client.end().catch(() => {})
    }
  },
} satisfies ExportedHandler<Env>
