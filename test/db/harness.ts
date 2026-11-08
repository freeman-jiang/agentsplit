// The app in process for the database tests: a copy of the test database, the
// whole request handler of src/server/main/app.ts on it (RPC, MCP, Better Auth,
// the plain HTTP routes and the maintenance switch), the in-memory receipts
// bucket, synthetic accounts and groups, and the MCP client.
import { Schema } from 'effect'
import type { Pool, PoolClient } from 'pg'
import { user } from '../../db/schema/auth'
import { createApp } from '~/server/main/app'
import { MCP_TOOLS } from '~/server/mcp/tools'
import { createAuth } from '~/server/auth/auth'
import type { Bucket } from '~/server/bucket'
import type { AppSettings } from '~/server/core/config'
import { makeDb } from '~/server/core/db'
import { instrumentPool } from '~/server/perf'
import { BASE, SECRET, testSettings } from '../kit/config'
import { testDatabase } from '../kit/database'
import { mcpClient, type Call } from '../kit/mcp'
import { principal, userRows } from '../kit/people'
import { createPrivateContext, seedGroup } from '../kit/seed'
import { signIn } from '../kit/session'
import { fakeBucket } from './fake-bucket'
import type { CurrencyCode } from '~/shared/currencies'
import { MCP_PATH } from '~/shared/mcp'
import type { Role } from '~/shared/vocabulary'

export { BASE, SECRET }
export const MCP_URL = `${BASE}${MCP_PATH}`

export type Harness = Awaited<ReturnType<typeof startHarness>>

/**
 * The whole app on `pool`, as main/server.ts builds it, with the in-memory
 * bucket and a stand-in SPA page. `connect` replaces the pool's connections,
 * and `assets` the SPA page.
 */
export function testApp(data: { pool: Pool; settings?: AppSettings; bucket?: Bucket; connect?: () => Promise<PoolClient>; assets?: (request: Request) => Promise<Response> }) {
  return createApp({
    config: data.settings ?? testSettings(),
    connect: data.connect ?? (() => data.pool.connect()),
    pool: makeDb(data.pool),
    bucket: data.bucket ?? fakeBucket().bucket,
    assets: data.assets ?? (async () => new Response('SPA page', { headers: { 'Content-Type': 'text/html' } })),
  })
}

/**
 * `perf` turns on PERF_INSTRUMENTATION: each answer reports its statements
 * (perf.ts). `maintenance` turns on AGENTSPLIT_MAINTENANCE.
 */
export async function startHarness(options: { perf?: boolean; maintenance?: boolean } = {}) {
  const database = await testDatabase()
  const { pool, withDb } = database
  if (options.perf) instrumentPool(pool)
  const storage = fakeBucket()
  const settings = testSettings({ perfInstrumentation: options.perf ?? false, maintenance: options.maintenance ?? false })
  const app = testApp({ pool, settings, bucket: storage.bucket })
  /** One request through the app, as Bun.serve hands it over. */
  const fetch = (request: Request) => app.fetch(request)
  const mcp = mcpClient({ baseUrl: BASE, send: fetch })

  /** Better Auth's server API on one connection, as the app's hooks use it. */
  const authApi = <A>(work: (api: ReturnType<typeof createAuth>['api']) => Promise<A>) => withDb((db) => work(createAuth({ ...settings, db }).api))
  /** Better Auth's own handler, without the routes that the app serves in its place. */
  const betterAuth = (request: Request) => withDb((db) => createAuth({ ...settings, db }).handler(request))

  /** An account (verified unless asked) with a signed web session cookie. */
  async function account(id: string, data: { name?: string; verified?: boolean } = {}) {
    return withDb(async (db) => {
      await db.insert(user).values(userRows([principal(id, { name: data.name ?? id })], { verified: data.verified ?? true }))
      return { id, cookie: (await signIn(db, { userId: id, secret: SECRET, baseUrl: BASE })).header }
    })
  }

  /** A raw API key and its ID, from Better Auth's own createApiKey, as Settings creates it. */
  const apiKeyWithId = (userId: string) =>
    authApi(async (api) => {
      const created = await api.createApiKey({ body: { userId } })
      return { key: created.key, id: created.id }
    })
  const apiKey = async (userId: string) => (await apiKeyWithId(userId)).key

  /** A named group with participants named `Name <id>` (seedGroup); members are [userId, participantId, role], the first an admin who created it. */
  const group = (data: { id: string; name?: string; slug?: string; currency?: CurrencyCode; people: string[]; members: readonly [[string, string, 'admin'], ...[string, string | null, Role][]] }) => {
    const [[creator, participantId], ...rest] = data.members
    return database.tx((db) =>
      seedGroup(db, {
        groupId: data.id,
        slug: data.slug ?? null,
        name: data.name ?? data.id,
        ...(data.currency ? { currency: data.currency } : {}),
        people: data.people.map((p) => ({ id: p, name: `Name ${p}` })),
        creator: principal(creator),
        members: [{ userId: creator, participantId, role: 'admin' }, ...rest.map(([userId, participant, role]) => ({ userId, participantId: participant, role }))],
      }),
    )
  }

  /** A real private context: one ungrouped expense between the owner and a friend. Returns its group ID. */
  const privateContext = (data: { owner: string; expenseId: string }) =>
    database.tx((tx) => createPrivateContext(tx, { owner: principal(data.owner), expenseId: data.expenseId, baseUrl: BASE }))

  return { ...database, storage, app, fetch, mcp, authApi, betterAuth, account, apiKey, apiKeyWithId, group, privateContext }
}

/** One message of the RPC answer: the call's exit, in Effect RPC's JSON form. */
export type RpcExit = { _tag: 'Exit'; requestId: string; exit: { _tag: 'Success'; value: unknown } | { _tag: 'Failure'; cause: unknown } }

/** One Effect RPC call to /api/rpc with a web session, as the client sends it. */
export async function webRpc(h: Harness, data: { tag: string; payload: object; cookie: string }): Promise<{ response: Response; exit: RpcExit['exit'] }> {
  const response = await h.fetch(
    new Request(`${BASE}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: data.cookie, origin: BASE },
      body: JSON.stringify([{ _tag: 'Request', id: '1', tag: data.tag, payload: data.payload, headers: [] }]),
    }),
  )
  const messages = (await response.clone().json()) as RpcExit[]
  const exit = messages.find((m) => m._tag === 'Exit')?.exit
  if (!exit) throw new Error(`${data.tag}: no exit in ${JSON.stringify(messages)}`)
  return { response, exit }
}

/** The structured result of a successful call, which must decode with the tool's advertised output schema. */
export async function checked(h: Harness, call: Call) {
  const result = await h.mcp.ok(call)
  const tool = MCP_TOOLS.find((t) => t.name === call.name)
  if (!tool) throw new Error(`No tool ${call.name}`)
  Schema.decodeUnknownSync(tool.output as Schema.Codec<unknown>)(result)
  return result
}
