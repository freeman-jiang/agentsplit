// The platform rules whose failure stays silent: a wrong cache header keeps
// old code in browsers after a deploy, and a wrong schedule never runs the
// recurring expenses.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { assetHandler, loadAssets } from '../src/server/assets'
import { nextRun } from '../src/server/hourly'

describe('static files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentsplit-assets-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>AgentSplit</title>')
  writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {})')
  const chunk = 'export const a = 1;'.repeat(100)
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), chunk)
  writeFileSync(join(dir, 'assets', 'index-abc123.js.gz'), gzipSync(chunk))
  writeFileSync(join(dir, '_headers'), '/*\n  X-Test: 1\n')
  const assets = loadAssets(dir)
  if (!assets) throw new Error('no assets')
  const serve = assetHandler(assets)
  const get = (path: string, headers: Record<string, string> = {}) => serve(new Request(`https://app.example${path}`, { headers }))

  it('keeps hashed files for a year and revalidates everything else', async () => {
    expect((await get('/assets/index-abc123.js')).headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    for (const path of ['/', '/index.html', '/sw.js', '/home-1234/expenses'])
      expect((await get(path)).headers.get('cache-control'), path).toBe('no-cache')
  })

  it('serves the SPA page for app paths, but never for a missing chunk or the rule file', async () => {
    const page = await get('/home-1234/expenses')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await page.text()).toContain('<title>AgentSplit</title>')
    expect((await get('/assets/index-old999.js')).status).toBe(404)
    expect(await (await get('/_headers')).text()).toContain('<title>AgentSplit</title>')
  })

  it('answers a matching ETag with 304, and sends the compressed copy only to clients that accept it', async () => {
    const first = await get('/')
    const etag = first.headers.get('etag') ?? ''
    expect((await get('/', { 'if-none-match': etag })).status).toBe(304)
    const zipped = await get('/assets/index-abc123.js', { 'accept-encoding': 'gzip, br;q=0' })
    expect(zipped.headers.get('content-encoding')).toBe('gzip')
    expect(zipped.headers.get('vary')).toBe('Accept-Encoding')
    const plain = await get('/assets/index-abc123.js', { 'accept-encoding': 'gzip;q=0' })
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(await plain.text()).toBe(chunk)
  })
})

describe('hourly job', () => {
  it('runs at minute 7 of the next hour, and never twice for one hour', () => {
    expect(nextRun(new Date('2026-11-05T10:00:00Z'), 7).toISOString()).toBe('2026-11-05T10:07:00.000Z')
    expect(nextRun(new Date('2026-11-05T10:07:00Z'), 7).toISOString()).toBe('2026-11-05T11:07:00.000Z')
    expect(nextRun(new Date('2026-11-05T23:59:59Z'), 7).toISOString()).toBe('2026-11-06T00:07:00.000Z')
  })
})

describe('maintenance', () => {
  // The cutover relies on this: users and agents get 503, Coolify's health check passes.
  it('answers 503 to pages, API calls and MCP, but lets the health checks through', async () => {
    const { maintenanceResponse } = await import('~/server/maintenance')
    for (const path of ['/api/health', '/api/health/readiness', '/api/health/liveness']) expect(maintenanceResponse(new Request(`https://a.example${path}`))).toBeNull()
    const page = maintenanceResponse(new Request('https://a.example/maple', { headers: { accept: 'text/html,*/*' } }))
    expect(page?.status).toBe(503)
    expect(page?.headers.get('content-type')).toContain('text/html')
    for (const path of ['/api/rpc', '/api/mcp', '/api/receipt-uploads/x']) {
      const response = maintenanceResponse(new Request(`https://a.example${path}`, { method: 'POST', headers: { accept: 'application/json' } }))
      expect(response?.status).toBe(503)
      expect(response?.headers.get('retry-after')).toBe('300')
    }
  })
})

describe('settings', () => {
  const env = {
    BASE_URL: 'https://a.example',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    DATABASE_URL: 'postgresql://localhost/db',
    S3_UPLOAD_ENDPOINT: 'http://garage:3900',
    S3_UPLOAD_KEY: 'key',
    S3_UPLOAD_SECRET: 'secret',
  }
  // A bad setting must stop the start, not the first sign-in hours later.
  it('refuses a short secret, a missing setting and a malformed number at start', async () => {
    const { readSettings } = await import('~/server/core/config')
    expect(readSettings(env).app).toMatchObject({ signUpDailyLimit: 200, perfInstrumentation: false })
    expect(() => readSettings({ ...env, BETTER_AUTH_SECRET: 'short' })).toThrow('Set BETTER_AUTH_SECRET to at least 32 characters')
    expect(() => readSettings({ ...env, GOOGLE_CLIENT_ID: ' ' })).toThrow('Set GOOGLE_CLIENT_ID')
    expect(() => readSettings({ ...env, SIGN_UP_DAILY_LIMIT: '10k' })).toThrow('Set SIGN_UP_DAILY_LIMIT to a whole number of accounts per day')
  })
})
