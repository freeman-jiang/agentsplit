// The receipts bucket on an S3 API (R2 in production, Garage in the end-to-end tests).
// Bun's S3Client signs path-style SigV4 URLs locally; fetch() runs every request with an
// explicit AbortSignal timeout so a stalled storage endpoint can never hang a request or
// the hourly job indefinitely.
import { S3Client } from 'bun'
import type { Bucket } from './bucket'

/** Timeout for HEAD and DELETE calls. */
const META_TIMEOUT_MS = 15_000
/** Timeout for GET bytes and PUT uploads (receipts are at most 5 MiB). */
const TRANSFER_TIMEOUT_MS = 30_000
/** Total time a streamed receipt GET may stay open. */
const STREAM_TIMEOUT_MS = 60_000
/** Expiry of locally signed internal URLs (must cover the longest request timeout). */
const SIGN_SECONDS = 120
/** Parallel S3 deletes per batch call. */
const DELETE_CONCURRENCY = 8

export type S3Timeouts = {
  readonly metaMs?: number
  readonly transferMs?: number
  readonly streamMs?: number
}

async function toBytes(body: Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  if (body instanceof Uint8Array) return new Uint8Array(body)
  return new Uint8Array(await new Response(body).arrayBuffer())
}

export function s3Bucket(
  config: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string },
  timeouts: S3Timeouts = {},
): Bucket {
  const client = new S3Client({ ...config, virtualHostedStyle: false })
  const metaMs = timeouts.metaMs ?? META_TIMEOUT_MS
  const transferMs = timeouts.transferMs ?? TRANSFER_TIMEOUT_MS
  const streamMs = timeouts.streamMs ?? STREAM_TIMEOUT_MS

  const sign = (key: string, method: 'HEAD' | 'GET' | 'PUT' | 'DELETE') => client.presign(key, { method, expiresIn: SIGN_SECONDS })

  return {
    async get(key, options) {
      const head = await fetch(sign(key, 'HEAD'), { method: 'HEAD', signal: AbortSignal.timeout(metaMs) })
      void head.body?.cancel().catch(() => undefined)
      if (head.status === 404) return null
      if (!head.ok) throw new Error(`S3 HEAD ${key} failed with ${head.status}`)
      const size = Number(head.headers.get('content-length') ?? 0)
      const contentType = head.headers.get('content-type') ?? 'application/octet-stream'
      const empty = size === 0 || (options !== undefined && (options.range.length <= 0 || options.range.offset >= size))
      const rangeHeader =
        !empty && options ? { Range: `bytes=${options.range.offset}-${Math.min(size - 1, options.range.offset + options.range.length - 1)}` } : undefined

      return {
        size,
        contentType,
        async bytes() {
          if (empty) return new Uint8Array(0)
          const res = await fetch(sign(key, 'GET'), { method: 'GET', ...(rangeHeader ? { headers: rangeHeader } : {}), signal: AbortSignal.timeout(transferMs) })
          if (!res.ok) {
            void res.body?.cancel().catch(() => undefined)
            throw new Error(`S3 GET ${key} failed with ${res.status}`)
          }
          return new Uint8Array(await res.arrayBuffer())
        },
        stream() {
          if (empty) return new ReadableStream<Uint8Array>({ start: (c) => c.close() })
          const abort = new AbortController()
          const timer = setTimeout(() => abort.abort(new DOMException('S3 stream timed out', 'TimeoutError')), streamMs)
          let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
          const cleanup = () => clearTimeout(timer)
          return new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                if (!reader) {
                  const res = await fetch(sign(key, 'GET'), {
                    method: 'GET',
                    ...(rangeHeader ? { headers: rangeHeader } : {}),
                    signal: abort.signal,
                  })
                  if (!res.ok || !res.body) {
                    void res.body?.cancel().catch(() => undefined)
                    throw new Error(`S3 GET ${key} failed with ${res.status}`)
                  }
                  reader = res.body.getReader()
                }
                const next = await reader.read()
                if (next.done) {
                  cleanup()
                  controller.close()
                } else {
                  controller.enqueue(next.value)
                }
              } catch (error) {
                cleanup()
                controller.error(error)
              }
            },
            async cancel() {
              cleanup()
              abort.abort()
              await reader?.cancel().catch(() => undefined)
            },
          })
        },
      }
    },
    async put(key, body, options) {
      const bytes = await toBytes(body)
      const res = await fetch(sign(key, 'PUT'), {
        method: 'PUT',
        headers: { 'Content-Type': options.contentType },
        body: bytes,
        signal: AbortSignal.timeout(transferMs),
      })
      void res.body?.cancel().catch(() => undefined)
      if (!res.ok) throw new Error(`S3 PUT ${key} failed with ${res.status}`)
      return { size: bytes.byteLength, etag: res.headers.get('etag') ?? '' }
    },
    async delete(keys) {
      const list = typeof keys === 'string' ? [keys] : [...new Set(keys)]
      for (let i = 0; i < list.length; i += DELETE_CONCURRENCY) {
        await Promise.all(
          list.slice(i, i + DELETE_CONCURRENCY).map(async (key) => {
            const res = await fetch(sign(key, 'DELETE'), { method: 'DELETE', signal: AbortSignal.timeout(metaMs) })
            void res.body?.cancel().catch(() => undefined)
            if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key} failed with ${res.status}`)
          }),
        )
      }
    },
    // Signed locally, with no request. The overrides become the signed query
    // parameters response-content-type and response-content-disposition.
    presignGet(key, options) {
      return client.presign(key, { method: 'GET', expiresIn: options.expiresIn, type: options.contentType, contentDisposition: options.contentDisposition })
    },
  }
}
