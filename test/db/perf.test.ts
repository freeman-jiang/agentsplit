// Performance runs read the database work of a request from its headers
// (P-PWA-49). A missing header only shows up as an empty column in a report.
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app'
import type { AppSettings } from '../../src/server/config'
import { makeDb } from '../../src/server/db'
import { instrumentPool, withPerfCounters } from '../../src/server/perf'
import { fakeBucket } from './fake-bucket'
import { resetTestDatabase } from './setup'

let pool: Pool
beforeAll(async () => {
  // The listener wraps new connections only, as in server.ts, so it goes on a pool with none open.
  const migrated = await resetTestDatabase()
  await migrated.end()
  pool = new Pool({ connectionString: migrated.options.connectionString, max: 2 })
  instrumentPool(pool)
})
afterAll(async () => {
  await pool.end()
})

const config = (perfInstrumentation: boolean): AppSettings => ({
  baseUrl: 'https://app.example',
  secret: 'test-secret-0123456789abcdef0123456789abcdef',
  googleClientId: 'test',
  googleClientSecret: 'test',
  bootstrapEmail: undefined,
  signUpDailyLimit: 200,
  perfInstrumentation,
})

const appWith = (perfInstrumentation: boolean) =>
  createApp({
    config: config(perfInstrumentation),
    connect: () => pool.connect(),
    pool: makeDb(pool),
    bucket: fakeBucket().bucket,
    assets: async () => new Response('page'),
  })

describe('performance headers', () => {
  it('reports the statements and database time of a request only when PERF_INSTRUMENTATION is on', async () => {
    const on = await appWith(true).fetch(new Request('https://app.example/api/health'))
    expect(on.status).toBe(200)
    expect(on.headers.get('x-perf-db-queries')).toBe('1')
    expect(on.headers.get('server-timing')).toMatch(/^db;dur=\d+\.\d$/)
    expect(on.headers.get('x-content-type-options')).toBe('nosniff')

    const off = await appWith(false).fetch(new Request('https://app.example/api/health'))
    expect(off.headers.get('x-perf-db-queries')).toBeNull()
    expect(off.headers.get('server-timing')).toBeNull()
  })

  it('counts the statements that Better Auth sends through the pool', async () => {
    const counters = { queries: 0, dbMs: 0 }
    await withPerfCounters(counters, async () => {
      await pool.query('SELECT 1')
      await pool.query('SELECT 2')
    })
    expect(counters.queries).toBe(2)
    expect(counters.dbMs).toBeGreaterThan(0)
  })
})
