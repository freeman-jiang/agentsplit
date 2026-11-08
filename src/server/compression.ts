// Gzip for the dynamic responses whose whole body the app holds (RPC, Better
// Auth, MCP, the CSV and JSON exports): data that leaves the VM costs money
// above the free tier. Static files have their own compressed copies
// (assets.ts). Streams (a receipt image, the receipt ZIP) never come here, so
// nothing reads a body of unknown size into memory. Gzip and not Brotli: the
// VM has about a quarter of a core, and Cloudflare encodes again for browsers.
import { constants, crc32, deflateRawSync, gzipSync } from 'node:zlib'

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

/**
 * Text formats. Images other than SVG, archives and fonts are compressed
 * already. text/event-stream is included: the MCP handler answers each call as
 * one buffered event-stream message, and every body here is complete.
 */
function compressible(contentType: string | null) {
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type.endsWith('+json') ||
    type === 'application/javascript' ||
    type === 'application/xml' ||
    type.endsWith('+xml')
  )
}

/** Whether a response of `status` with `headers` and `byteLength` bytes gets gzipped for a client that accepts gzip. */
export function gzipEligible(data: { request: Request; status: number; headers: Headers; byteLength: number }) {
  const { status, headers } = data
  return (
    data.request.method !== 'HEAD' &&
    status >= 200 &&
    status < 300 &&
    status !== 204 &&
    !headers.has('content-encoding') &&
    data.byteLength >= MIN_BYTES &&
    compressible(headers.get('content-type'))
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
  if (!gzipEligible({ request, status: init.status ?? 200, headers, byteLength: body.byteLength })) return new Response(body, init)
  headers.append('Vary', 'Accept-Encoding')
  if (!accepts(request.headers.get('accept-encoding') ?? '', 'gzip')) return new Response(body, init)
  headers.set('Content-Encoding', 'gzip')
  // Bun sends the length of the new body.
  headers.delete('Content-Length')
  const etag = headers.get('etag')
  if (etag?.startsWith('"')) headers.set('ETag', `W/${etag}`)
  return new Response(new Uint8Array(gzipSync(body, { level: LEVEL })), init)
}

/** The gzip header with no name, no time and an unknown OS (RFC 1952). */
const GZIP_HEADER = Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff)

/**
 * Gzip of `head` followed by a short tail that changes, with `head`
 * compressed once. The head's deflate data ends with a full flush, which ends
 * on a byte boundary and lets nothing after it refer back, so each tail is
 * compressed on its own and appended. The result is one standard gzip
 * member, with the CRC-32 and length of the whole text.
 */
export function gzipWithTail(head: Uint8Array) {
  const deflatedHead = deflateRawSync(head, { level: LEVEL, finishFlush: constants.Z_FULL_FLUSH })
  const headCrc = crc32(head)
  return (tail: Uint8Array): Uint8Array<ArrayBuffer> => {
    const deflatedTail = deflateRawSync(tail, { level: LEVEL })
    const out = new Uint8Array(GZIP_HEADER.length + deflatedHead.length + deflatedTail.length + 8)
    out.set(GZIP_HEADER, 0)
    out.set(deflatedHead, GZIP_HEADER.length)
    out.set(deflatedTail, GZIP_HEADER.length + deflatedHead.length)
    const trailer = new DataView(out.buffer, out.length - 8)
    trailer.setUint32(0, crc32(tail, headCrc), true)
    trailer.setUint32(4, (head.length + tail.length) % 2 ** 32, true)
    return out
  }
}
