import { env } from 'cloudflare:workers'
import { Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import pg from 'pg'
import { createAuth } from './auth'
import { databaseLayer, makeDb } from './db'
import type { Env } from './env'
import { Api, AppConfig, AuthMiddlewareLive, HandlersLive } from './rpc'

const config = (e: Env) => ({
  baseUrl: e.BASE_URL,
  secret: e.BETTER_AUTH_SECRET,
  googleClientId: e.GOOGLE_CLIENT_ID,
  googleClientSecret: e.GOOGLE_CLIENT_SECRET,
})

/** Built once per isolate. Bindings are read per call, so each request gets its own connection. */
let rpcHandler: ((request: Request) => Promise<Response>) | undefined
function rpc() {
  if (rpcHandler) return rpcHandler
  const appEnv = env as unknown as Env
  const services = Layer.mergeAll(databaseLayer(() => appEnv.HYPERDRIVE.connectionString), Layer.succeed(AppConfig, config(appEnv)))
  const server = RpcServer.layerHttp({ group: Api, path: '/api/rpc', protocol: 'http' }).pipe(
    Layer.provide(HandlersLive),
    Layer.provide(AuthMiddlewareLive),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(services),
  )
  const { handler } = HttpRouter.toWebHandler(server)
  rpcHandler = (request) => handler(request)
  return rpcHandler
}

/** Better Auth on one connection that lives for this request. */
async function auth(request: Request, appEnv: Env) {
  const client = new pg.Client({ connectionString: appEnv.HYPERDRIVE.connectionString })
  await client.connect()
  try {
    return await createAuth({ ...config(appEnv), db: makeDb(client) }).handler(request)
  } finally {
    await client.end().catch(() => {})
  }
}

const noStore = (response: Response) => {
  const copy = new Response(response.body, response)
  copy.headers.set('Cache-Control', 'no-store')
  return copy
}

export default {
  async fetch(request, appEnv) {
    const url = new URL(request.url)
    // The Effect RPC client joins its base URL with a slash, so it posts to /api/rpc/.
    if (url.pathname === '/api/rpc' || url.pathname === '/api/rpc/') {
      url.pathname = '/api/rpc'
      return noStore(await rpc()(new Request(url, request)))
    }
    if (url.pathname.startsWith('/api/auth/')) return noStore(await auth(request, appEnv))
    if (url.pathname === '/api/health') return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
    if (url.pathname.startsWith('/api/')) return Response.json({ error: 'Not found' }, { status: 404 })
    return appEnv.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
