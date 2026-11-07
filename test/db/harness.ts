// The app in process for the database tests: a copy of the test database, the
// whole request handler of src/server/main/app.ts on it (RPC, MCP, Better Auth,
// the plain HTTP routes and the maintenance switch), the in-memory receipts
// bucket, synthetic accounts and groups, and the MCP client.
import { groups, memberships, participants } from '../../db/schema/app'
import { user } from '../../db/schema/auth'
import { createApp } from '~/server/main/app'
import { createAuth } from '~/server/auth/auth'
import { makeDb } from '~/server/core/db'
import { instrumentPool } from '~/server/perf'
import { BASE, SECRET, testSettings } from '../kit/config'
import { testDatabase } from '../kit/database'
import { mcpClient, type Call } from '../kit/mcp'
import { principal } from '../kit/people'
import { createPrivateContext } from '../kit/seed'
import { signIn } from '../kit/session'
import { fakeBucket } from './fake-bucket'
import type { CurrencyCode } from '~/shared/currencies'

export { BASE, SECRET }
export const MCP_URL = `${BASE}/api/mcp`

export type Harness = Awaited<ReturnType<typeof startHarness>>

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
  const app = createApp({
    config: settings,
    connect: () => pool.connect(),
    pool: makeDb(pool),
    bucket: storage.bucket,
    assets: async () => new Response('SPA page', { headers: { 'Content-Type': 'text/html' } }),
  })
  /** One request through the app, as Bun.serve hands it over. */
  const fetch = (request: Request) => app.fetch(request)
  const mcp = mcpClient({ baseUrl: BASE, send: fetch })

  /** Better Auth's server API on one connection, as the app's hooks use it. */
  const authApi = <A>(work: (api: ReturnType<typeof createAuth>['api']) => Promise<A>) => withDb((db) => work(createAuth({ ...settings, db }).api))
  /** Better Auth's own handler, without the routes that the app serves in its place. */
  const betterAuth = (request: Request) => withDb((db) => createAuth({ ...settings, db }).handler(request))

  /** An account (verified unless asked) with a signed web session cookie. */
  async function account(id: string, data: { name?: string; verified?: boolean } = {}) {
    const now = new Date()
    return withDb(async (db) => {
      await db.insert(user).values({ id, name: data.name ?? id, email: `${id}@example.com`, emailVerified: data.verified ?? true, createdAt: now, updatedAt: now })
      return { id, cookie: (await signIn(db, { userId: id, secret: SECRET, baseUrl: BASE })).header }
    })
  }

  /** A raw API key from Better Auth's own createApiKey, as Settings creates it. */
  const apiKey = (userId: string) => authApi(async (api) => (await api.createApiKey({ body: { userId } })).key)

  /** A named group with participants named `Name <id>`; members are [userId, participantId, role]. */
  async function group(data: { id: string; name?: string; slug?: string; currency?: CurrencyCode; people: string[]; members: [string, string | null, 'admin' | 'member'][] }) {
    await withDb(async (db) => {
      await db.insert(groups).values({ id: data.id, kind: 'named', slug: data.slug ?? null, name: data.name ?? data.id, defaultCurrency: data.currency ?? 'USD' })
      if (data.people.length) await db.insert(participants).values(data.people.map((p) => ({ id: p, groupId: data.id, name: `Name ${p}` })))
      for (const [userId, participantId, role] of data.members) await db.insert(memberships).values({ userId, groupId: data.id, participantId, role })
    })
  }

  /** A real private context: one ungrouped expense between the owner and a friend. Returns its group ID. */
  const privateContext = (data: { owner: string; expenseId: string }) =>
    database.tx((tx) => createPrivateContext(tx, { owner: principal(data.owner), expenseId: data.expenseId, baseUrl: BASE }))

  return { ...database, storage, app, fetch, mcp, authApi, betterAuth, account, apiKey, group, privateContext }
}

/** One JSON-RPC request through the app. */
export const rpc = (h: Harness, call: Parameters<Harness['mcp']['rpc']>[0]) => h.mcp.rpc(call)
/** Calls a tool and returns its result, or the HTTP answer when the call never ran. */
export const callTool = (h: Harness, call: Call) => h.mcp.callTool(call)
/** The structured result of a successful call; fails the test with the answer otherwise. */
export const ok = (h: Harness, call: Call) => h.mcp.ok(call)
/** The `{error}` body of a failed call. */
export const failure = (h: Harness, call: Call) => h.mcp.failure(call)
