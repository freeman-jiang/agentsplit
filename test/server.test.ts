// The platform rules whose failure stays silent: a wrong cache header keeps
// old code in browsers after a deploy, and a wrong schedule never runs the
// recurring expenses.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { assetHandler, clientFiles, loadAssets } from '../src/server/assets'
import { readSettings } from '../src/server/core/config'
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
  const assets = loadAssets({ dir, baseUrl: 'https://app.example' })
  if (!assets) throw new Error('no assets')
  const serve = assetHandler(assets)
  const get = (path: string, headers: Record<string, string> = {}) => serve(new Request(`https://app.example${path}`, { headers }))

  it('keeps hashed files for a year and revalidates everything else', async () => {
    expect((await get('/assets/index-abc123.js')).headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    for (const path of ['/', '/index.html', '/sw.js', '/home-1234/expenses'])
      expect((await get(path)).headers.get('cache-control'), path).toBe('no-cache')
  })

  it('serves the SPA page for app paths, but never for a missing chunk', async () => {
    const page = await get('/home-1234/expenses')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await page.text()).toContain('<title>AgentSplit</title>')
    expect((await get('/assets/index-old999.js')).status).toBe(404)
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

describe('the client build at start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentsplit-build-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  // Link previews ignore relative image URLs, and only the server knows its public origin.
  it('writes the public origin into the page’s share-preview URLs, in every encoding', async () => {
    writeFileSync(join(dir, 'index.html'), '<meta property="og:image" content="/banner.png" /><meta property="og:url" content="/" /><meta name="twitter:image" content="/banner.png" />')
    writeFileSync(join(dir, 'index.html.gz'), gzipSync('stale'))
    const serve = clientFiles({ dir, baseUrl: 'https://agentsplit.example/ignored' })
    const expected =
      '<meta property="og:image" content="https://agentsplit.example/banner.png" /><meta property="og:url" content="https://agentsplit.example/" /><meta name="twitter:image" content="https://agentsplit.example/banner.png" />'
    expect(await (await serve(new Request('https://agentsplit.example/groups'))).text()).toBe(expected)
    const zipped = await serve(new Request('https://agentsplit.example/', { headers: { 'accept-encoding': 'gzip' } }))
    expect(zipped.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(new Uint8Array(await zipped.arrayBuffer())).toString()).toBe(expected)
  })

  // A wrong CLIENT_DIR would otherwise pass the health checks and answer every page with 404.
  it('stops the start when CLIENT_DIR names no build', () => {
    const missing = join(dir, 'missing')
    expect(() => clientFiles({ dir: missing, baseUrl: 'https://agentsplit.example' })).toThrow(`Set CLIENT_DIR to the client build: ${missing} has none`)
  })
})

describe('hourly job', () => {
  it('runs at minute 7 of the next hour, and never twice for one hour', () => {
    expect(nextRun(new Date('2026-11-05T10:00:00Z'), 7).toISOString()).toBe('2026-11-05T10:07:00.000Z')
    expect(nextRun(new Date('2026-11-05T10:07:00Z'), 7).toISOString()).toBe('2026-11-05T11:07:00.000Z')
    expect(nextRun(new Date('2026-11-05T23:59:59Z'), 7).toISOString()).toBe('2026-11-06T00:07:00.000Z')
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
  it('refuses a short secret, a missing setting and a malformed number at start', () => {
    // The base settings start; each case below changes one of them.
    expect(readSettings(env).app.baseUrl).toBe('https://a.example')
    expect(() => readSettings({ ...env, BETTER_AUTH_SECRET: 'short' })).toThrow('Set BETTER_AUTH_SECRET to at least 32 characters')
    expect(() => readSettings({ ...env, GOOGLE_CLIENT_ID: ' ' })).toThrow('Set GOOGLE_CLIENT_ID')
    expect(() => readSettings({ ...env, SIGN_UP_DAILY_LIMIT: '10k' })).toThrow('Set SIGN_UP_DAILY_LIMIT to a whole number of accounts per day')
  })
})
