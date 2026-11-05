import { env } from 'cloudflare:workers'
import { Layer, Scheduler } from 'effect'
import { HttpRouter } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import pg from 'pg'
import { makeDb, registerRequestDb, releaseRequestDb, REQUEST_ID_HEADER } from './db'
import type { Env } from './env'
import { HandlersLive } from './handlers'
import { Api, AppConfig, AuthMiddlewareLive } from './rpc'
import { livenessResponse, readinessResponse, robotsTxt, secured, sitemapXml } from './security'

const appEnv = env as unknown as Env
const config = {
  baseUrl: appEnv.BASE_URL,
  secret: appEnv.BETTER_AUTH_SECRET,
  googleClientId: appEnv.GOOGLE_CLIENT_ID,
  googleClientSecret: appEnv.GOOGLE_CLIENT_SECRET,
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
  // OAuth discovery: Better Auth serves the protected-resource and authorization-server metadata.
  if (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/.well-known/')) return authHandler(request)
  if (url.pathname === '/api/health' || url.pathname === '/api/health/readiness') return readinessResponse(checkDatabase)
  if (url.pathname === '/api/health/liveness') return livenessResponse()
  if (url.pathname === '/robots.txt') return robotsTxt(config.baseUrl)
  if (url.pathname === '/sitemap.xml') return sitemapXml(config.baseUrl)
  if (url.pathname.startsWith('/api/')) return Response.json({ error: 'Not found' }, { status: 404 })
  return appEnv.ASSETS.fetch(request)
}

export default {
  async fetch(request) {
    return secured(await route(request))
  },
} satisfies ExportedHandler<Env>
