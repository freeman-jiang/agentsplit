// The app's one request handler and its hourly job. The platform (the HTTP
// server, the connection pool, the bucket client and the static files) is in
// server.ts beside it; this module reaches it only through `Platform`. The
// plain HTTP routes are in the *-routes.ts modules beside this one.
import { Context, Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import type pg from 'pg'
import { todayUtc } from '../../shared/dates'
import { REQUEST_ID_RESPONSE_HEADER } from '../../shared/ids'
import { MCP_PATH } from '../../shared/mcp'
import { createAuth, type Auth } from '../auth/auth'
import { httpReader } from '../auth/authenticate'
import { METADATA_PATHS, protectedResourceMetadata } from '../auth/challenge'
import { removeExpiredDpopProofs } from '../auth/oauth'
import { handleAuthRoute } from '../auth/oauth-routes'
import { originAllowed } from '../auth/origin'
import { requestSession } from '../auth/session'
import type { Bucket } from '../bucket'
import type { AppSettings } from '../core/config'
import { makeDb, type Db } from '../core/db'
import { downloadExport } from '../export-routes'
import { groupRedirect, idPathOf } from '../group-urls'
import { AccountHandlers } from '../handlers/account'
import { CoreHandlers } from '../handlers/core'
import { ExpensesHandlers } from '../handlers/expenses'
import { FeedHandlers } from '../handlers/feed'
import { GroupsHandlers } from '../handlers/groups'
import { HistoryHandlers } from '../handlers/history'
import { StorageHandlers } from '../handlers/storage'
import { secured } from '../headers'
import { jsonError } from '../core/errors'
import { maintenanceResponse } from '../maintenance'
import { handleMcp } from '../mcp/endpoint'
import type { McpSettings } from '../mcp/server'
import { withPerfHeaders } from '../perf'
import { HEALTH_PATHS, livenessResponse, readinessResponse, robotsTxt, sitemapXml } from '../public-pages'
import { downloadReceipt, downloadReceiptArchive, putUpload, uploadReceipt } from '../receipt-routes'
import { removeStaleUploads } from '../receipt-uploads'
import { materializeDue } from '../recurring'
import { Api, AppConfig, AuthMiddlewareLive, ReceiptBucket, RpcRequest } from '../rpc'
import { purgeDeletedReceipts } from '../storage'

export type Platform = {
  readonly config: AppSettings
  /** One pooled database connection. Release it once; release(true) closes it. */
  readonly connect: () => Promise<pg.PoolClient>
  /** The pool itself, for Better Auth: each of its statements takes a pooled connection. */
  readonly pool: Db
  readonly bucket: Bucket
  /** A static file of the client build, or the SPA page. */
  readonly assets: (request: Request) => Promise<Response>
}

export function createApp(platform: Platform) {
  const { config, bucket } = platform
  const { baseUrl, secret } = config
  const mcpSettings: McpSettings = { baseUrl, bucket }

  // Built once: the RPC server's shared fiber must not belong to any one
  // request. Per-request state (the database connection) arrives in each
  // request's context instead, which the RPC server passes to every call.
  const rpcHandler = HttpRouter.toWebHandler(
    RpcServer.layerHttp({ group: Api, path: '/api/rpc', protocol: 'http' }).pipe(
      Layer.provide(Layer.mergeAll(CoreHandlers, GroupsHandlers, FeedHandlers, AccountHandlers, ExpensesHandlers, HistoryHandlers, StorageHandlers)),
      Layer.provide(AuthMiddlewareLive),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(Layer.succeed(AppConfig, { baseUrl, secret })),
      Layer.provide(Layer.succeed(ReceiptBucket, bucket)),
    ),
  ).handler

  /**
   * Runs `work` on one connection of this request. A failure closes the
   * connection, so a connection in an unknown state never goes back to the pool.
   */
  async function withClient<A>(work: (client: pg.PoolClient) => Promise<A>): Promise<A> {
    const client = await platform.connect()
    let failed = false
    try {
      return await work(client)
    } catch (error) {
      failed = true
      throw error
    } finally {
      client.release(failed)
    }
  }
  const withDb = <A>(work: (db: Db) => Promise<A>) => withClient((client) => work(makeDb(client)))

  /** The response with its whole body read, and the given Cache-Control. */
  async function complete(data: { response: Response; cacheControl: string }): Promise<Response> {
    const { response } = data
    const body = await response.arrayBuffer()
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', data.cacheControl)
    return new Response(body, { status: response.status, statusText: response.statusText, headers })
  }

  /**
   * Runs `work` with one database connection for this request, and releases
   * it after the response body is complete.
   */
  function withConnection(work: (db: Db) => Promise<Response>, cacheControl = 'no-store'): Promise<Response> {
    return withDb(async (db) => complete({ response: await work(db), cacheControl }))
  }

  /**
   * Better Auth, built on the first auth request and kept. Its hooks (the owner
   * bootstrap, the connection claims) use the pool too; none needs the
   * request's own connection. Three OAuth routes get the revocation checks of
   * src/server/auth/oauth-routes.ts.
   */
  let auth: Auth | undefined
  async function authHandler(request: Request): Promise<Response> {
    try {
      const ready = (auth ??= createAuth({ ...config, db: platform.pool }))
      const response = await handleAuthRoute({ db: platform.pool, request, baseUrl, secret, handle: (r) => ready.handler(r) })
      return await complete({ response, cacheControl: 'no-store' })
    } catch (error) {
      // Better Auth answers client errors itself (4xx). Only a real failure gets here.
      console.error('Auth handler failed', error)
      return jsonError({ status: 503, message: 'Sign-in is temporarily unavailable' })
    }
  }

  /** SELECT 1 on a pooled connection, so a failed connect is reported as unhealthy too. */
  const checkDatabase = () => withClient(async (client) => void (await client.query('SELECT 1')))

  async function route(request: Request): Promise<Response> {
    const paused = config.maintenance && maintenanceResponse(request)
    if (paused) return paused
    const url = new URL(request.url)
    // The Effect RPC client joins its base URL with a slash, so it posts to /api/rpc/.
    if (url.pathname === '/api/rpc' || url.pathname === '/api/rpc/') {
      if (!originAllowed({ request, baseUrl, cookieWrite: request.method === 'POST' })) return jsonError({ status: 403, message: 'Origin not allowed' })
      url.pathname = '/api/rpc'
      const requestId = crypto.randomUUID()
      const rpcRequest = request.url === url.href ? request : new Request(url, { method: request.method, headers: request.headers, body: request.body })
      const response = await withConnection((db) => rpcHandler(rpcRequest, Context.make(RpcRequest, { db, requestId })), 'private, no-store')
      // The error page shows this ID, and the server logs each failed call with it (AuthMiddlewareLive).
      response.headers.set(REQUEST_ID_RESPONSE_HEADER, requestId)
      return response
    }
    if (url.pathname === MCP_PATH) return withConnection((db) => handleMcp(request, { db, settings: mcpSettings }))
    // The server serves the protected-resource metadata itself: Better Auth's MCP plugin drops
    // offline_access from it, which left Claude Code without refresh tokens (OAUTH-CLAUDE-CODE.md).
    if (METADATA_PATHS.has(url.pathname)) return protectedResourceMetadata(request, baseUrl)
    // OAuth discovery: Better Auth serves the authorization-server metadata.
    if (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/.well-known/')) return authHandler(request)
    if (HEALTH_PATHS.has(url.pathname)) return url.pathname === '/api/health/liveness' ? livenessResponse() : readinessResponse(checkDatabase)
    if (url.pathname === '/robots.txt') return robotsTxt(baseUrl)
    if (url.pathname === '/sitemap.xml') return sitemapXml(baseUrl)
    if (url.pathname === '/api/receipts') {
      // Not withConnection: the image streams from the bucket after the database work is done, with its own headers.
      if (request.method === 'GET')
        return withDb(async (db) =>
          downloadReceipt({ db, bucket, url, reader: await httpReader(db, { request, baseUrl, secret, signIn: 'Authentication required' }) }),
        )
      if (request.method === 'POST') {
        // An upload is a cookie-authorized write: other origins are refused before any database work, as for RPC.
        if (!originAllowed({ request, baseUrl, cookieWrite: true })) return jsonError({ status: 403, message: 'Origin not allowed' })
        return withDb(async (db) => uploadReceipt({ db, bucket, request, principal: await requestSession(db, { request, secret, baseUrl }) }))
      }
      return jsonError({ status: 405, message: 'Method not allowed' })
    }
    // An agent's upload target from create_expense or update_expense. The secret in the path is the credential.
    const uploadRoute = /^\/api\/receipt-uploads\/([^/]+)$/.exec(url.pathname)
    if (uploadRoute) {
      if (request.method !== 'PUT') return jsonError({ status: 405, message: 'Method not allowed', headers: { Allow: 'PUT' } })
      return withDb((db) => putUpload({ db, bucket, request, token: uploadRoute[1] ?? '' }))
    }
    const receiptsRoute = /^\/(?:groups\/)?([^/]+)\/expenses\/export\/receipts$/.exec(url.pathname)
    if (receiptsRoute && request.method === 'GET') return downloadReceiptArchive({ withDb, bucket, request, group: receiptsRoute[1] ?? '', baseUrl, secret })
    const exportRoute = /^\/(?:groups\/)?([^/]+)\/expenses\/export\/(csv|json)$/.exec(url.pathname)
    if (exportRoute && request.method === 'GET') {
      const [, group = '', format] = exportRoute
      return withConnection((db) => downloadExport({ db, request, group, format: format === 'json' ? 'json' : 'csv', baseUrl, secret }), 'private, no-store')
    }
    // The current app's presigned upload route is gone for good (P-RECEIPT-28).
    if (url.pathname === '/api/s3-upload') return jsonError({ status: 410, message: 'Use the authenticated receipt upload flow' })
    if (url.pathname.startsWith('/api/')) return jsonError({ status: 404, message: 'Not found' })
    // The current app's group URLs: /groups/<id>/… moves to the group's slug (src/server/group-urls.ts).
    const idPath = request.method === 'GET' || request.method === 'HEAD' ? idPathOf(url.pathname) : null
    if (idPath) {
      const target = await withDb((db) => groupRedirect(db, { path: idPath }))
      if (target) return new Response(null, { status: 307, headers: { Location: `${target}${url.search}`, 'Cache-Control': 'private, no-store' } })
    }
    return platform.assets(request)
  }

  return {
    async fetch(request: Request): Promise<Response> {
      return secured(await (config.perfInstrumentation ? withPerfHeaders(() => route(request)) : route(request)))
    },
    /**
     * The hourly job (server.ts runs it at minute 7). It creates due
     * recurring expenses, so reads never have to (DECISIONS.md, P-BAL-30 and
     * P-RECUR-08). A failed occurrence is logged and skipped, the other links
     * go on, and the next run tries it again.
     * It also removes stale upload targets, the objects of deleted receipts
     * that are still in storage, and expired DPoP replay rows. It pauses in
     * maintenance, so nothing writes then.
     */
    async scheduled(time: Date): Promise<void> {
      if (config.maintenance) return
      await withDb(async (db) => {
        const created = await materializeDue(db, {
          today: todayUtc(time),
          onError: (error, linkId) => console.error('Recurring expense failed; its link waits for the next run', { linkId }, error),
        })
        if (created.length) console.log(`Created ${created.length} recurring expenses`)
        const removed = await removeStaleUploads({ db, bucket })
        if (removed) console.log(`Removed ${removed} stale receipt upload targets`)
        const purged = await purgeDeletedReceipts({ db, bucket })
        if (purged) console.log(`Removed ${purged} deleted receipts from storage`)
        const proofs = await removeExpiredDpopProofs(db)
        if (proofs) console.log(`Removed ${proofs} expired DPoP replay rows`)
      })
    },
  }
}

export type App = ReturnType<typeof createApp>
