import { env } from 'cloudflare:workers'
import { Layer, Scheduler } from 'effect'
import { HttpRouter } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import pg from 'pg'
import { makeDb, registerRequestDb, releaseRequestDb, REQUEST_ID_HEADER } from './db'
import type { Env } from './env'
import { HandlersLive } from './handlers'
import { Api, AppConfig, AuthMiddlewareLive } from './rpc'

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
async function withConnection(work: (client: pg.Client) => Promise<Response>): Promise<Response> {
  const client = new pg.Client({ connectionString: appEnv.HYPERDRIVE.connectionString })
  await client.connect()
  try {
    const response = await work(client)
    const body = await response.arrayBuffer()
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-store')
    return new Response(body, { status: response.status, statusText: response.statusText, headers })
  } finally {
    await client.end().catch(() => {})
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    // The Effect RPC client joins its base URL with a slash, so it posts to /api/rpc/.
    if (url.pathname === '/api/rpc' || url.pathname === '/api/rpc/') {
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
      })
    }
    if (url.pathname.startsWith('/api/auth/'))
      // Better Auth loads only for these routes, so RPC requests never parse it.
      return withConnection(async (client) => (await import('./auth')).createAuth({ ...config, db: makeDb(client) }).handler(request))
    if (url.pathname === '/api/health') return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
    if (url.pathname.startsWith('/api/')) return Response.json({ error: 'Not found' }, { status: 404 })
    return appEnv.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
