// The client build (dist/client), served from memory. Vite's hashed files
// under /assets/ never change, so browsers keep them for a year. Every other
// file, and the SPA page, is revalidated on each load with its ETag, so a
// deploy reaches every browser at once. scripts/build-server.ts writes the
// .br and .gz copies beside each text file.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

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

/** Reads every file of `dir` once, at startup. Returns null if there is no build. */
export function loadAssets(dir: string): ReadonlyMap<string, Asset> | null {
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
    // The compressed copies are variants of their file.
    if (/\.(br|gz)$/.test(name)) continue
    const bytes = new Uint8Array(readFileSync(file))
    const variants: Variant[] = []
    if (present.has(`${file}.br`)) variants.push({ bytes: new Uint8Array(readFileSync(`${file}.br`)), encoding: 'br' })
    if (present.has(`${file}.gz`)) variants.push({ bytes: new Uint8Array(readFileSync(`${file}.gz`)), encoding: 'gzip' })
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

/** Whether the client accepts `encoding`, from Accept-Encoding; q=0 refuses it. */
function accepts(header: string, encoding: 'br' | 'gzip') {
  return header.split(',').some((part) => {
    const [name, ...params] = part.trim().split(';')
    return name?.trim().toLowerCase() === encoding && !params.some((p) => /^\s*q=0(\.0*)?\s*$/.test(p))
  })
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
