// Performance runs read the database work of a request from its headers
// (P-PWA-49). A missing header only shows up as an empty column in a report.
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { instrumentPool, withPerfCounters } from '../../src/server/perf'
import { testSettings } from '../kit/config'
import { testDatabase, type TestDatabase } from '../kit/database'
import { testApp } from './harness'

let database: TestDatabase
let pool: Pool
beforeAll(async () => {
  database = await testDatabase()
  pool = database.pool
  // The listener wraps new connections only, as in server.ts; the new pool has none open yet.
  instrumentPool(pool)
})
afterAll(() => database.close())

const appWith = (perfInstrumentation: boolean) => testApp({ pool, settings: testSettings({ baseUrl: 'https://app.example', perfInstrumentation }) })

describe('performance headers', () => {
  it('reports the statements and database time of a request only when PERF_INSTRUMENTATION is on', async () => {
    const on = await appWith(true).fetch(new Request('https://app.example/api/health'))
    expect(on.status).toBe(200)
    expect(Number(on.headers.get('x-perf-db-queries'))).toBeGreaterThan(0)
    expect(on.headers.get('server-timing')).toMatch(/^db;dur=\d+\.\d$/)
    expect(on.headers.get('x-content-type-options')).toBe('nosniff')

    const off = await appWith(false).fetch(new Request('https://app.example/api/health'))
    expect(off.headers.get('x-perf-db-queries')).toBeNull()
    expect(off.headers.get('server-timing')).toBeNull()
  })

  it('counts the statements sent with pool.query, the way Better Auth sends them', async () => {
    const counters = { queries: 0, dbMs: 0 }
    await withPerfCounters(counters, async () => {
      await pool.query('SELECT 1')
      await pool.query('SELECT 2')
    })
    expect(counters.queries).toBe(2)
    expect(counters.dbMs).toBeGreaterThan(0)
  })
})
