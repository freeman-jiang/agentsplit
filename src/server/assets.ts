// The client build (dist/client), served from memory. Vite's hashed files
// under /assets/ never change, so browsers keep them for a year. Every other
// file, and the SPA page, is revalidated on each load with its ETag, so a
// deploy reaches every browser at once. scripts/build-server.ts writes the
// .br and .gz copies beside each text file.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { accepts } from './compression'

const TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  woff2: 'font/woff2',
}

const IMMUTABLE = 'public, max-age=31536000, immutable'
const REVALIDATE = 'no-cache'

type Variant = { readonly bytes: Uint8Array<ArrayBuffer>; readonly encoding: 'br' | 'gzip' | null }
type Asset = { readonly type: string; readonly etag: string; readonly cacheControl: string; readonly variants: readonly Variant[] }

const extension = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

/**
 * The SPA page with absolute share-preview URLs. Link previews (Open Graph,
 * X cards) need absolute ones, and only the server knows its public origin.
 */
export function withShareUrls(data: { html: string; baseUrl: string }): string {
  const origin = new URL(data.baseUrl).origin
  return data.html.replace(
    /(<meta (?:property|name)="(?:og:image|og:url|twitter:image)" content=")(\/[^"]*)"/g,
    (_, start: string, path: string) => `${start}${origin}${path}"`,
  )
}

/** Reads every file of `dir` once, at startup, with the SPA page's share-preview URLs on `baseUrl`. Returns null if there is no build. */
export function loadAssets(data: { dir: string; baseUrl: string }): ReadonlyMap<string, Asset> | null {
  const { dir } = data
  let all: string[]
  try {
    all = files(dir)
  } catch {
    return null
  }
  const assets = new Map<string, Asset>()
  const present = new Set(all)
  for (const file of all) {
    const name = relative(dir, file).split('\\').join('/')
    if (/\.(br|gz)$/.test(name)) continue
    const variants: Variant[] = []
    let bytes = new Uint8Array(readFileSync(file))
    if (name === 'index.html') {
      // The page changes here, so its build-time copies are stale: compress it again.
      bytes = new TextEncoder().encode(withShareUrls({ html: new TextDecoder().decode(bytes), baseUrl: data.baseUrl }))
      variants.push({ bytes: new Uint8Array(brotliCompressSync(bytes)), encoding: 'br' }, { bytes: new Uint8Array(gzipSync(bytes)), encoding: 'gzip' })
    } else {
      if (present.has(`${file}.br`)) variants.push({ bytes: new Uint8Array(readFileSync(`${file}.br`)), encoding: 'br' })
      if (present.has(`${file}.gz`)) variants.push({ bytes: new Uint8Array(readFileSync(`${file}.gz`)), encoding: 'gzip' })
    }
    variants.push({ bytes, encoding: null })
    assets.set(`/${name}`, {
      type: TYPES[extension(name)] ?? 'application/octet-stream',
      etag: `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 27)}"`,
      cacheControl: name.startsWith('assets/') ? IMMUTABLE : REVALIDATE,
      variants,
    })
  }
  return assets
}

function respond(request: Request, asset: Asset): Response {
  const encodings = request.headers.get('accept-encoding') ?? ''
  const variant = asset.variants.find((v) => v.encoding === null || accepts(encodings, v.encoding)) ?? asset.variants[asset.variants.length - 1]
  const headers = new Headers({ 'Content-Type': asset.type, 'Cache-Control': asset.cacheControl, ETag: asset.etag })
  if (asset.variants.length > 1) headers.set('Vary', 'Accept-Encoding')
  if (request.headers.get('if-none-match')?.split(',').some((tag) => tag.trim().replace(/^W\//, '') === asset.etag))
    return new Response(null, { status: 304, headers })
  if (variant?.encoding) headers.set('Content-Encoding', variant.encoding)
  // For HEAD, Bun sends the headers and the length without the body.
  return new Response(variant?.bytes ?? null, { headers })
}

/**
 * The static files of the build in `dir` (CLIENT_DIR). A `dir` that is set
 * must hold a build, so a wrong setting stops the start. Without it, the
 * server looks in dist/client and answers 404 when there is no build: the
 * dev server's client comes from Vite.
 */
export function clientFiles(data: { dir: string | undefined; baseUrl: string }): (request: Request) => Promise<Response> {
  const assets = loadAssets({ dir: data.dir ?? 'dist/client', baseUrl: data.baseUrl })
  if (assets) return assetHandler(assets)
  if (data.dir !== undefined) throw new Error(`Set CLIENT_DIR to the client build: ${data.dir} has none`)
  return async () => new Response('No client build', { status: 404 })
}

/**
 * The static handler. A file path serves its file. Any other path serves the
 * SPA page, except under /assets/: a missing chunk is a 404, so an old page
 * that asks for a removed chunk gets an error instead of HTML.
 */
export function assetHandler(assets: ReadonlyMap<string, Asset>) {
  const page = assets.get('/index.html')
  if (!page) throw new Error('The client build has no index.html')
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } })
    const path = new URL(request.url).pathname
    const asset = assets.get(path === '/' ? '/index.html' : path)
    if (asset) return respond(request, asset)
    if (path.startsWith('/assets/')) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
    return respond(request, page)
  }
}
