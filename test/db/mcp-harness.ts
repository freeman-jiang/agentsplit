// Shared setup for the MCP tests: a fresh database, the MCP endpoint and the
// Better Auth handler in process, synthetic accounts, and JSON-RPC helpers.
import { serializeSignedCookie } from 'better-call'
import type { Pool } from 'pg'
import { groups, memberships, participants } from '../../db/schema/app'
import { session, user } from '../../db/schema/auth'
import { createApp } from '~/server/main/app'
import { createAuth } from '~/server/auth/auth'
import { makeDb, type Db } from '~/server/core/db'
import { handleMcp } from '~/server/mcp/endpoint'
import { handleAuthRoute } from '~/server/auth/oauth-routes'
import { createUngroupedExpense } from '~/server/ungrouped'
import { fakeBucket } from './fake-bucket'
import { resetTestDatabase } from './setup'

export const BASE = 'http://localhost'
export const SECRET = 'mcp-test-secret-0123456789-0123456789-0123456789'
export const MCP_URL = `${BASE}/api/mcp`
export const LEGACY = '2025-06-18'
/** The sign-in settings of the in-process server. */
export const AUTH = { baseUrl: BASE, secret: SECRET, googleClientId: 'test-google', googleClientSecret: 'test-google-secret', bootstrapEmail: undefined, signUpDailyLimit: 200 }

export type Harness = Awaited<ReturnType<typeof startHarness>>

export async function startHarness() {
  const pool: Pool = await resetTestDatabase()
  /** Runs work on one pooled connection, as the server does per request. */
  const withDb = async <A>(work: (db: Db) => Promise<A>): Promise<A> => {
    const client = await pool.connect()
    try {
      return await work(makeDb(client))
    } finally {
      client.release()
    }
  }
  /** The in-memory receipts bucket. */
  const r2 = fakeBucket()
  const mcp = (request: Request) => withDb((db) => handleMcp(request, { db, settings: { baseUrl: BASE, bucket: r2.bucket } }))
  /** The whole request handler of src/server/app.ts, for the plain HTTP routes (exports, receipts). */
  const app = createApp({
    config: { ...AUTH, perfInstrumentation: false },
    connect: () => pool.connect(),
    pool: makeDb(pool),
    bucket: r2.bucket,
    assets: async () => new Response('SPA page'),
  })
  /** Better Auth behind the server's OAuth route checks, as src/server/app.ts sends /api/auth/* requests. */
  const auth = (request: Request) =>
    withDb((db) => {
      const instance = createAuth({ ...AUTH, db })
      return handleAuthRoute({ db, request, baseUrl: BASE, secret: SECRET, handle: (r) => instance.handler(r) })
    })
  const authApi = <A>(work: (api: ReturnType<typeof createAuth>['api']) => Promise<A>) =>
    withDb((db) => work(createAuth({ ...AUTH, db }).api))

  /** A verified (or unverified) account with a signed web session cookie. */
  async function account(id: string, data: { name?: string; verified?: boolean } = {}) {
    const now = new Date()
    await withDb(async (db) => {
      await db.insert(user).values({ id, name: data.name ?? id, email: `${id}@example.com`, emailVerified: data.verified ?? true, createdAt: now, updatedAt: now })
      await db.insert(session).values({ id: `s-${id}`, token: `token-${id}`, userId: id, expiresAt: new Date(Date.now() + 86_400_000), createdAt: now, updatedAt: now })
    })
    const cookie = (await serializeSignedCookie('better-auth.session_token', `token-${id}`, SECRET)).split(';')[0] ?? ''
    return { id, cookie }
  }

  /** A raw API key from Better Auth's own createApiKey, as Settings creates it. */
  const apiKey = (userId: string) => authApi(async (api) => (await api.createApiKey({ body: { userId } })).key)

  /** A named group with participants; members are [userId, participantId, role]. */
  async function group(data: { id: string; name?: string; slug?: string; currency?: string; people: string[]; members: [string, string | null, 'admin' | 'member'][] }) {
    await withDb(async (db) => {
      await db.insert(groups).values({ id: data.id, kind: 'named', slug: data.slug ?? null, name: data.name ?? data.id, defaultCurrency: data.currency ?? 'USD' })
      if (data.people.length) await db.insert(participants).values(data.people.map((p) => ({ id: p, groupId: data.id, name: `Name ${p}` })))
      for (const [userId, participantId, role] of data.members) await db.insert(memberships).values({ userId, groupId: data.id, participantId, role })
    })
  }

  /** A real private context: one ungrouped expense between the owner and a friend. */
  async function privateContext(data: { owner: string; expenseId: string }) {
    const result = await withDb((db) =>
      db.transaction(
        (tx) =>
          createUngroupedExpense(tx, {
            principal: { userId: data.owner, name: data.owner, email: `${data.owner}@example.com`, source: 'web', agentKeyId: null },
            baseUrl: BASE,
            expenseId: data.expenseId,
            idempotencyKey: `key-${data.expenseId}`,
            people: [
              { kind: 'account', id: 'me', userId: data.owner },
              { kind: 'email', id: 'friend', name: 'Friend', email: `friend-${data.expenseId}@example.com` },
            ],
            expense: {
              kind: 'expense',
              title: 'Private dinner',
              vendor: null,
              notes: '',
              categoryId: 0,
              expenseDate: '2026-11-02',
              currency: 'USD',
              amount: '10.00',
              payers: [{ participantId: 'me', amount: '10.00' }],
              splitMode: 'evenly',
              shares: [{ participantId: 'me', weight: '1' }, { participantId: 'friend', weight: '1' }],
              recurrence: 'none',
            },
          }),
        { isolationLevel: 'serializable' },
      ),
    )
    return result.groupId
  }

  return { pool, withDb, r2, mcp, app, auth, authApi, account, apiKey, group, privateContext, close: () => pool.end() }
}

let nextId = 1

export type Rpc = { status: number; headers: Headers; body: unknown }

/** One JSON-RPC request in the 2025 (legacy) protocol, the form Claude Code and Codex send today. */
export async function rpc(h: Harness, data: { method: string; params?: object; headers?: Record<string, string> }): Promise<Rpc> {
  const response = await h.mcp(
    new Request(MCP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': LEGACY, ...data.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: data.method, params: data.params ?? {} }),
    }),
  )
  const text = await response.text()
  // Legacy exchanges may answer as one SSE event.
  const json = text.match(/^data: (.*)$/m)?.[1] ?? text
  return { status: response.status, headers: response.headers, body: json ? (JSON.parse(json) as unknown) : null }
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text: string }[] }

/** Calls a tool and returns its result, or the HTTP response when the call never ran. */
export async function callTool(h: Harness, data: { name: string; args?: object; headers: Record<string, string> }) {
  const r = await rpc(h, { method: 'tools/call', params: { name: data.name, arguments: data.args ?? {} }, headers: data.headers })
  const result = (r.body as { result?: ToolResult } | null)?.result
  return { ...r, result }
}

/** The structured result of a successful call; fails the test with the error text otherwise. */
export async function ok(h: Harness, data: { name: string; args?: object; headers: Record<string, string> }): Promise<Record<string, unknown>> {
  const r = await callTool(h, data)
  if (r.status !== 200 || !r.result || r.result.isError || !r.result.structuredContent)
    throw new Error(`${data.name} failed: ${r.status} ${JSON.stringify(r.body)}`)
  return r.result.structuredContent
}

/** The parsed `{error}` body of a failed call. */
export async function failure(h: Harness, data: { name: string; args?: object; headers: Record<string, string> }) {
  const r = await callTool(h, data)
  if (r.status !== 200 || !r.result?.isError) throw new Error(`${data.name} did not fail: ${r.status} ${JSON.stringify(r.body)}`)
  const text = r.result.content[0]?.text ?? ''
  try {
    return (JSON.parse(text) as { error: { code: string; message: string; outcomeUnknown: boolean; recovery: string } }).error
  } catch {
    // Validation errors from the SDK are plain text.
    return { code: 'VALIDATION', message: text, outcomeUnknown: false, recovery: 'correct_arguments' }
  }
}
