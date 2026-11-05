import { env } from 'cloudflare:workers'
import { Layer, Scheduler } from 'effect'
import { HttpRouter } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import pg from 'pg'
import { makeDb, registerRequestDb, releaseRequestDb, REQUEST_ID_HEADER } from './db'
import type { Env } from './env'
import { HandlersLive } from './handlers'
import { Api, AppConfig, AuthMiddlewareLive } from './rpc'
import { sessionPrincipal } from './session'
import { Forbidden } from '../shared/api'

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
    const exportRoute = /^\/(?:groups\/)?([^/]+)\/expenses\/export\/(csv|json)$/.exec(url.pathname)
    if (exportRoute && request.method === 'GET') {
      const [, group = '', format] = exportRoute
      const response = await withConnection((client) =>
        exportGroup({ db: makeDb(client), cookie: request.headers.get('cookie'), group, format: format === 'json' ? 'json' : 'csv' }),
      )
      // Downloads stay out of shared caches, as in the current app.
      response.headers.set('Cache-Control', 'private, no-store')
      return response
    }
    if (url.pathname === '/api/health') return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
    if (url.pathname.startsWith('/api/')) return Response.json({ error: 'Not found' }, { status: 404 })
    return appEnv.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
