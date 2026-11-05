import { env } from 'cloudflare:workers'
import { Layer, Scheduler } from 'effect'
import { HttpRouter } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import pg from 'pg'
import { makeDb, registerRequestDb, releaseRequestDb, REQUEST_ID_HEADER, type Db } from './db'
import type { Env } from './env'
import { HandlersLive } from './handlers'
import { Api, AppConfig, AuthMiddlewareLive } from './rpc'

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
    if (url.pathname === '/api/receipts') {
      if (request.method !== 'GET' && request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 })
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
    // The current app's presigned upload route is gone for good (P-RECEIPT-28).
    if (url.pathname === '/api/s3-upload')
      return Response.json({ error: 'Use the authenticated receipt upload flow' }, { status: 410, headers: { 'Cache-Control': 'no-store' } })
    if (url.pathname === '/api/health') return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
    if (url.pathname.startsWith('/api/')) return Response.json({ error: 'Not found' }, { status: 404 })
    return appEnv.ASSETS.fetch(request)
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
