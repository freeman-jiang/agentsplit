// The app's one request handler and its hourly job. The platform (the HTTP
// server, the connection pool, the bucket client and the static files) is in
// src/server/server.ts; this module reaches it only through `Platform`.
import { Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import type pg from 'pg'
import { createAuth, type Auth } from './auth'
import type { Bucket } from './bucket'
import { makeDb, registerRequestDb, releaseRequestDb, REQUEST_ID_HEADER, type Db } from './db'
import { exportCsv, exportJson, exportResponse } from './export'
import { HandlersLive } from './handlers'
import { METADATA_PATHS, protectedResourceMetadata } from './mcp/challenge'
import { handleMcp } from './mcp/endpoint'
import { removeExpiredDpopProofs } from './mcp/oauth'
import { putUpload, removeStaleUploads } from './receipt-uploads'
import { downloadReceipt, receiptReader, uploadReceipt } from './receipts'
import { materializeDue } from './recurring'
import { Api, AppConfig, AuthMiddlewareLive } from './rpc'
import { Forbidden } from '../shared/api'
import { jsonError, livenessResponse, readinessResponse, robotsTxt, sameOrigin, secured, sitemapXml } from './security'
import { sessionPrincipal } from './session'

export type Config = AppConfig['Service'] & {
  /** The verified email that may claim the groups created before accounts existed. */
  readonly bootstrapEmail: string | undefined
}

export type Platform = {
  readonly config: Config
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

  // Built once: the RPC server's shared fiber must not belong to any one
  // request. Per-request state (the database connection) arrives in each
  // request's context instead.
  const rpcHandler = HttpRouter.toWebHandler(
    RpcServer.layerHttp({ group: Api, path: '/api/rpc', protocol: 'http' }).pipe(
      Layer.provide(HandlersLive),
      Layer.provide(AuthMiddlewareLive),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(Layer.succeed(AppConfig, config)),
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

  /** The signed-in web user of a plain HTTP request, from the session cookie. */
  async function principalOf(db: Db, request: Request) {
    return sessionPrincipal(db, { cookie: request.headers.get('cookie'), secret: config.secret, baseUrl: config.baseUrl })
  }

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
  function withConnection(work: (client: pg.PoolClient) => Promise<Response>, cacheControl = 'no-store'): Promise<Response> {
    return withClient(async (client) => complete({ response: await work(client), cacheControl }))
  }

  /**
   * Better Auth, built on the first auth request and kept. Its hooks (the owner
   * bootstrap, the connection claims) use the pool too; none needs the
   * request's own connection. A configuration error is not kept, so each
   * request reports it again.
   */
  let auth: Auth | undefined
  async function authHandler(request: Request): Promise<Response> {
    try {
      auth ??= createAuth({ ...config, db: platform.pool })
      return await complete({ response: await auth.handler(request), cacheControl: 'no-store' })
    } catch (error) {
      // Better Auth answers client errors itself (4xx). Only a real failure gets here.
      console.error('Auth handler failed', error)
      return jsonError({ status: 503, message: 'Sign-in is temporarily unavailable' })
    }
  }

  /** SELECT 1 on a pooled connection, so a failed connect is reported as unhealthy too. */
  const checkDatabase = () => withClient(async (client) => void (await client.query('SELECT 1')))

  /** CSV and JSON exports, at the current app's URLs: /groups/<id>/expenses/export/<format> and /<slug>/expenses/export/<format>. */
  async function exportGroup(data: { db: Db; cookie: string | null; group: string; format: 'csv' | 'json' }) {
    let group: string
    try {
      group = decodeURIComponent(data.group)
    } catch {
      return jsonError({ status: 404, message: 'Invalid group ID' })
    }
    const principal = await sessionPrincipal(data.db, { cookie: data.cookie, secret: config.secret, baseUrl: config.baseUrl })
    if (!principal) return jsonError({ status: 401, message: 'Sign in required' })
    try {
      return exportResponse(await (data.format === 'json' ? exportJson : exportCsv)(data.db, { principal, group }))
    } catch (error) {
      if (error instanceof Forbidden) return jsonError({ status: 403, message: 'Group access denied' })
      throw error
    }
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // The Effect RPC client joins its base URL with a slash, so it posts to /api/rpc/.
    if (url.pathname === '/api/rpc' || url.pathname === '/api/rpc/') {
      if (request.method === 'POST' && !sameOrigin({ request, baseUrl: config.baseUrl })) return jsonError({ status: 403, message: 'Origin not allowed' })
      url.pathname = '/api/rpc'
      // Only the server sets this header: it names the connection the middleware uses.
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
    if (url.pathname === '/api/mcp')
      return withConnection((client) => handleMcp(request, { db: makeDb(client), baseUrl: config.baseUrl, bucket, documentsEnabled: config.documentsEnabled }))
    // The server serves the protected-resource metadata itself: Better Auth's MCP plugin drops
    // offline_access from it, which left Claude Code without refresh tokens (OAUTH-CLAUDE-CODE.md).
    if (METADATA_PATHS.has(url.pathname))
      return protectedResourceMetadata(request, config.baseUrl)
    // OAuth discovery: Better Auth serves the authorization-server metadata.
    if (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/.well-known/')) return authHandler(request)
    if (url.pathname === '/api/health' || url.pathname === '/api/health/readiness') return readinessResponse(checkDatabase)
    if (url.pathname === '/api/health/liveness') return livenessResponse()
    if (url.pathname === '/robots.txt') return robotsTxt(config.baseUrl)
    if (url.pathname === '/sitemap.xml') return sitemapXml(config.baseUrl)
    if (url.pathname === '/api/receipts') {
      if (request.method !== 'GET' && request.method !== 'POST') return jsonError({ status: 405, message: 'Method not allowed' })
      // An upload is a cookie-authenticated write: other origins are refused before any database work, as for RPC.
      if (request.method === 'POST' && !sameOrigin({ request, baseUrl: config.baseUrl })) return jsonError({ status: 403, message: 'Origin not allowed' })
      // Not withConnection: the image streams from the bucket after the database work is done, with its own headers.
      return withClient(async (client) => {
        const db = makeDb(client)
        return request.method === 'GET'
          ? downloadReceipt({ db, bucket, principal: await receiptReader(db, { request, baseUrl: config.baseUrl, secret: config.secret }), url })
          : uploadReceipt({ db, bucket, principal: await principalOf(db, request), request, baseUrl: config.baseUrl, enabled: config.documentsEnabled })
      })
    }
    // An agent's upload target from create_expense or update_expense. The secret in the path is the credential.
    const uploadRoute = /^\/api\/receipt-uploads\/([^/]+)$/.exec(url.pathname)
    if (uploadRoute) {
      if (request.method !== 'PUT') return jsonError({ status: 405, message: 'Method not allowed', headers: { Allow: 'PUT' } })
      return withClient((client) => putUpload({ db: makeDb(client), bucket, request, token: uploadRoute[1] ?? '', enabled: config.documentsEnabled }))
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
    if (url.pathname === '/api/s3-upload') return jsonError({ status: 410, message: 'Use the authenticated receipt upload flow' })
    if (url.pathname.startsWith('/api/')) return jsonError({ status: 404, message: 'Not found' })
    return platform.assets(request)
  }

  return {
    async fetch(request: Request): Promise<Response> {
      return secured(await route(request))
    },
    /**
     * The hourly job (src/server/server.ts runs it at minute 7). It creates due
     * recurring expenses, so reads never have to (DECISIONS.md, P-BAL-30 and
     * P-RECUR-08). A failed occurrence is logged and retried on the next run.
     * It also removes stale upload targets and expired DPoP replay rows.
     */
    scheduled(time: Date): Promise<void> {
      return withClient(async (client) => {
        const db = makeDb(client)
        const created = await materializeDue({
          today: time.toISOString().slice(0, 10),
          transaction: (work) => db.transaction(work, { isolationLevel: 'serializable' }),
          onError: (error) => console.error('Recurring expense failed', error),
        })
        if (created.length) console.log(`Created ${created.length} recurring expenses`)
        const removed = await removeStaleUploads({ db, bucket })
        if (removed) console.log(`Removed ${removed} stale receipt upload targets`)
        const proofs = await removeExpiredDpopProofs(db)
        if (proofs) console.log(`Removed ${proofs} expired DPoP replay rows`)
      })
    },
  }
}

export type App = ReturnType<typeof createApp>
