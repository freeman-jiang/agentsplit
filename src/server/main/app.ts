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
import { AUTH_PATH, exportRouteOf, RECEIPTS_PATH, receiptUploadTokenOf, ROBOTS_PATH, RPC_PATH, SITEMAP_PATH } from '../../shared/paths'
import { createAuth, type Auth } from '../auth/auth'
import { httpReader } from '../auth/authenticate'
import { METADATA_PATHS, protectedResourceMetadata } from '../auth/challenge'
import { removeExpiredDpopProofs } from '../auth/oauth'
import { handleAuthRoute } from '../auth/oauth-routes'
import { originAllowed } from '../auth/origin'
import { requestSession } from '../auth/session'
import type { Bucket } from '../bucket'
import type { CallName, WithDb } from '../calls'
import { withBufferedBody } from '../core/body'
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
import { compressed } from '../compression'
import { API_HEADERS, documentHeaders, isHtml, secured } from '../headers'
import { jsonError } from '../core/errors'
import { removeExpiredIdempotencyKeys } from '../idempotency'
import { maintenanceResponse } from '../maintenance'
import { handleMcp } from '../mcp/endpoint'
import type { McpSettings } from '../mcp/server'
import { withPerfHeaders } from '../perf'
import { HEALTH_PATHS, LIVENESS_PATH, livenessResponse, readinessResponse, robotsTxt, sitemapXml } from '../public-pages'
import { downloadReceipt, downloadReceiptArchive, putUpload, uploadReceipt } from '../receipt-routes'
import { removeStaleUploads } from '../receipt-uploads'
import { materializeDue } from '../recurring'
import { Api, AppConfig, AuthMiddlewareLive, ReceiptBucket, RpcRequest } from '../rpc'
import { purgeDeletedReceipts } from '../storage'

/** The largest body of each route that reads it whole. The largest RPC call, an expense with every field full, is well below its limit. */
const RPC_BODY_BYTES = 1024 * 1024
const AUTH_BODY_BYTES = 256 * 1024
/** Maximum Effect RPC calls in one HTTP batch. The web client batches calls within 5 ms (at most ~10 per screen). */
const MAX_RPC_BATCH = 32
/** Client-side bound on the readiness SELECT 1 so a frozen database fails readiness cleanly. */
const HEALTH_QUERY_MS = 5_000

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
  const { receiptDownloads } = config
  const documents = documentHeaders({ receiptOrigin: receiptDownloads.mode === 'redirect' ? receiptDownloads.origin : undefined })
  /** A response of a route that keeps the document headers, though it may not be HTML: a static file or a receipt route. */
  const asDocument = async (response: Response | Promise<Response>) => secured({ response: await response, headers: documents })

  // Built once: the RPC server's shared fiber must not belong to any one
  // request. Per-request state (the database connection) arrives in each
  // request's context instead, which the RPC server passes to every call.
  const rpcHandler = HttpRouter.toWebHandler(
    RpcServer.layerHttp({ group: Api, path: RPC_PATH, protocol: 'http' }).pipe(
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

  /**
   * The response with its whole body read, and the given Cache-Control. Each
   * buffered dynamic response passes here, so here it is gzipped for clients
   * that accept it (compression.ts).
   */
  async function complete(data: { request: Request; response: Response; cacheControl: string }): Promise<Response> {
    const { request, response } = data
    const body = await response.arrayBuffer()
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', data.cacheControl)
    return compressed({ request, body, init: { status: response.status, statusText: response.statusText, headers } })
  }

  /**
   * Runs `work` with one database connection for this request, reads its
   * response body before releasing the connection, then compresses the body
   * outside the connection so synchronous gzip never holds a pool slot.
   */
  async function withConnection(request: Request, work: (db: Db) => Promise<Response>, cacheControl = 'no-store'): Promise<Response> {
    const { body, status, statusText, headers } = await withDb(async (db) => {
      const response = await work(db)
      return { body: await response.arrayBuffer(), status: response.status, statusText: response.statusText, headers: new Headers(response.headers) }
    })
    headers.set('Cache-Control', cacheControl)
    return compressed({ request, body, init: { status, statusText, headers } })
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
      return await complete({ request, response, cacheControl: 'no-store' })
    } catch (error) {
      // Better Auth answers client errors itself (4xx). Only a real failure gets here.
      console.error('Auth handler failed', error)
      return jsonError({ status: 503, message: 'Sign-in is temporarily unavailable' })
    }
  }

  /** The caller of a plain HTTP download on `db` (httpReader). `signIn` is the route's own 401 text, as in the current app. */
  const readerOf = (data: { request: Request; signIn: string }) => (db: Db) => httpReader(db, { ...data, baseUrl, secret })

  /** SELECT 1 on a pooled connection, bounded to HEALTH_QUERY_MS so a frozen database fails readiness fast and closes the client. */
  const checkDatabase = () =>
    withClient(async (client) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          client.query('SELECT 1'),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Database readiness query timed out')), HEALTH_QUERY_MS)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    })

  /** /api/receipts: a receipt image or its storage redirect, and a web upload. */
  async function receiptRoute(request: Request, url: URL): Promise<Response> {
    if (request.method === 'GET')
      return downloadReceipt({
        withDb,
        bucket,
        url,
        readerOf: readerOf({ request, signIn: 'Authentication required' }),
        downloads: receiptDownloads.mode,
      })
    if (request.method === 'POST') {
      // An upload is a cookie-authorized write: other origins are refused before any database work, as for RPC.
      if (!originAllowed({ request, baseUrl, cookieWrite: true })) return jsonError({ status: 403, message: 'Origin not allowed' })
      return uploadReceipt({ withDb, bucket, request, sessionOf: (db) => requestSession(db, { request, secret, baseUrl }) })
    }
    return jsonError({ status: 405, message: 'Method not allowed' })
  }

  async function route(request: Request): Promise<Response> {
    const paused = config.maintenance && maintenanceResponse(request)
    if (paused) return paused
    const url = new URL(request.url)
    if (url.pathname === RPC_PATH || url.pathname === `${RPC_PATH}/`) {
      if (!originAllowed({ request, baseUrl, cookieWrite: request.method === 'POST' })) return jsonError({ status: 403, message: 'Origin not allowed' })
      url.pathname = RPC_PATH
      const requestId = crypto.randomUUID()
      return withBufferedBody(request, { maxBytes: RPC_BODY_BYTES }, async (whole, bytes) => {
        if (whole.method === 'POST' && bytes.byteLength > 0) {
          try {
            const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
            if (Array.isArray(parsed) && parsed.length > MAX_RPC_BATCH)
              return jsonError({ status: 400, message: `Too many RPC calls in one request (max ${MAX_RPC_BATCH})` })
          } catch {
            // Let Effect RPC answer malformed JSON with its own error.
          }
        }
        const rpcRequest = whole.url === url.href ? whole : new Request(url, whole)
        const deferred: { work: (withDb: WithDb) => Promise<unknown>; call: CallName }[] = []
        const response = await withConnection(
          whole,
          (db) => rpcHandler(rpcRequest, Context.make(RpcRequest, { db, requestId, defer: (work, call) => void deferred.push({ work, call }) })),
          'private, no-store',
        )
        for (const { work, call } of deferred)
          await work(withDb).catch((error: unknown) => console.error(`${call.name}: work after the commit failed`, { requestId: call.requestId }, error))
        // The error page shows this ID, and the server logs each failed call with it (AuthMiddlewareLive).
        response.headers.set(REQUEST_ID_RESPONSE_HEADER, requestId)
        return response
      })
    }
    if (url.pathname === MCP_PATH)
      return complete({ request, response: await handleMcp(request, { withDb, settings: mcpSettings }), cacheControl: 'no-store' })
    // The server serves the protected-resource metadata itself: Better Auth's MCP plugin drops
    // offline_access from it, which left Claude Code without refresh tokens (docs/history/v2/OAUTH-CLAUDE-CODE.md).
    if (METADATA_PATHS.has(url.pathname)) return protectedResourceMetadata(request, baseUrl)
    // OAuth discovery: Better Auth serves the authorization-server metadata.
    if (url.pathname.startsWith(`${AUTH_PATH}/`) || url.pathname.startsWith('/.well-known/')) {
      return withBufferedBody(request, { maxBytes: AUTH_BODY_BYTES }, (whole) => authHandler(whole))
    }
    if (HEALTH_PATHS.has(url.pathname)) return url.pathname === LIVENESS_PATH ? livenessResponse() : readinessResponse(checkDatabase)
    if (url.pathname === ROBOTS_PATH) return robotsTxt(baseUrl)
    if (url.pathname === SITEMAP_PATH) return sitemapXml(baseUrl)
    if (url.pathname === RECEIPTS_PATH) return asDocument(receiptRoute(request, url))
    // An agent's upload target from create_expense or update_expense. The secret in the path is the credential.
    const uploadToken = receiptUploadTokenOf(url.pathname)
    if (uploadToken !== null) {
      if (request.method !== 'PUT') return asDocument(jsonError({ status: 405, message: 'Method not allowed', headers: { Allow: 'PUT' } }))
      return asDocument(putUpload({ withDb, bucket, request, token: uploadToken }))
    }
    const download = request.method === 'GET' ? exportRouteOf(url.pathname) : null
    if (download) {
      const { group, format } = download
      const reader = readerOf({ request, signIn: 'Sign in required' })
      if (format === 'receipts') return asDocument(downloadReceiptArchive({ withDb, bucket, group, readerOf: reader }))
      return withConnection(request, async (db) => downloadExport({ db, reader: await reader(db), group, format }), 'private, no-store')
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
    return asDocument(platform.assets(request))
  }

  return {
    async fetch(request: Request): Promise<Response> {
      let response: Response
      try {
        response = await (config.perfInstrumentation ? withPerfHeaders(() => route(request)) : route(request))
      } catch (error) {
        // A failure before a call's own error handling, such as no free pooled connection within its timeout.
        console.error('Request failed', { path: new URL(request.url).pathname }, error)
        response = jsonError({ status: 503, message: 'AgentSplit is temporarily unavailable. Try again in a moment.', headers: { 'Retry-After': '5' } })
      }
      return secured({ response, headers: isHtml(response) ? documents : API_HEADERS })
    },
    /**
     * The hourly job (server.ts schedules it). It creates due
     * recurring expenses, so reads never have to (docs/history/v2/DECISIONS.md, P-BAL-30 and
     * P-RECUR-08). A failed occurrence is logged and skipped, the other links
     * go on, and the next run tries it again.
     * It also removes stale upload targets, the objects of deleted receipts
     * that are still in storage, expired DPoP replay rows and expired
     * idempotency keys. Each step runs
     * on its own, so one that fails is logged and the others still run. It
     * pauses in maintenance, so nothing writes then.
     */
    async scheduled(time: Date): Promise<void> {
      if (config.maintenance) return
      const steps: readonly [string, () => Promise<number>][] = [
        [
          'recurring expenses created',
          () =>
            withDb(async (db) =>
              (
                await materializeDue(db, {
                  today: todayUtc(time),
                  onError: (error, linkId) => console.error('Recurring expense failed; its link waits for the next run', { linkId }, error),
                })
              ).length,
            ),
        ],
        ['stale receipt upload targets removed', () => removeStaleUploads({ withDb, bucket })],
        ['deleted receipts removed from storage', () => purgeDeletedReceipts({ withDb, bucket })],
        ['expired DPoP replay rows removed', () => withDb(removeExpiredDpopProofs)],
        ['expired idempotency keys removed', () => withDb(removeExpiredIdempotencyKeys)],
      ]
      for (const [what, step] of steps) {
        try {
          const count = await step()
          if (count) console.log(`Hourly job: ${count} ${what}`)
        } catch (error) {
          console.error(`Hourly job: the step "${what}" failed; the next run tries again`, error)
        }
      }
    },
  }
}

export type App = ReturnType<typeof createApp>
