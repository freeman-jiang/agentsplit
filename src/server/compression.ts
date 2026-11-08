// Gzip for the dynamic responses whose whole body the app holds (RPC, Better
// Auth, MCP, the CSV and JSON exports): data that leaves the VM costs money
// above the free tier. Static files have their own compressed copies
// (assets.ts). Streams (a receipt image, the receipt ZIP) never come here, so
// nothing reads a body of unknown size into memory. Gzip and not Brotli: the
// VM has about a quarter of a core, and Cloudflare encodes again for browsers.
import { gzipSync } from 'node:zlib'

/** Smaller bodies save less than the gzip header and the CPU cost. */
const MIN_BYTES = 1024
/** Near level 6 in size, at about two thirds of its CPU on API JSON. */
const LEVEL = 4

/** Whether the client accepts `encoding`, from Accept-Encoding; q=0 refuses it. */
export function accepts(header: string, encoding: 'br' | 'gzip') {
  return header.split(',').some((part) => {
    const [name, ...params] = part.trim().split(';')
    return name?.trim().toLowerCase() === encoding && !params.some((p) => /^\s*q=0(\.0*)?\s*$/.test(p))
  })
}

/** Text formats. Images other than SVG, archives and fonts are compressed already. */
function compressible(contentType: string | null) {
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (type === 'text/event-stream') return false
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type.endsWith('+json') ||
    type === 'application/javascript' ||
    type === 'application/xml' ||
    type.endsWith('+xml')
  )
}

/**
 * The response for `body` with `init`, gzipped when `request` accepts gzip and
 * the body is a large text format. A body that could be gzipped gets
 * `Vary: Accept-Encoding` in both forms, so a cache keeps them apart. A strong
 * ETag becomes weak on the gzipped form: its bytes differ from the plain form.
 */
export function compressed(data: { request: Request; body: ArrayBuffer; init: ResponseInit & { headers: Headers } }): Response {
  const { request, body, init } = data
  const { headers } = init
  const status = init.status ?? 200
  const eligible =
    request.method !== 'HEAD' &&
    status >= 200 &&
    status < 300 &&
    status !== 204 &&
    !headers.has('content-encoding') &&
    body.byteLength >= MIN_BYTES &&
    compressible(headers.get('content-type'))
  if (!eligible) return new Response(body, init)
  headers.append('Vary', 'Accept-Encoding')
  if (!accepts(request.headers.get('accept-encoding') ?? '', 'gzip')) return new Response(body, init)
  headers.set('Content-Encoding', 'gzip')
  // Bun sends the length of the new body.
  headers.delete('Content-Length')
  const etag = headers.get('etag')
  if (etag?.startsWith('"')) headers.set('ETag', `W/${etag}`)
  return new Response(new Uint8Array(gzipSync(body, { level: LEVEL })), init)
}
