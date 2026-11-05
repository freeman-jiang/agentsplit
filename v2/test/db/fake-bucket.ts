// An in-memory receipts bucket (src/server/bucket.ts). Like Garage, put reads
// a stream to its end and reports the stored size, and get can read a byte range.
import type { Bucket } from '../../src/server/bucket'

type Stored = { bytes: Uint8Array<ArrayBuffer>; contentType: string }

async function bytesOf(value: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  return new Uint8Array(await new Response(value).arrayBuffer())
}

export function fakeBucket() {
  const objects = new Map<string, Stored>()
  const calls: string[] = []
  const bucket: Bucket = {
    async get(k, options) {
      calls.push(`get ${k}`)
      const o = objects.get(k)
      if (!o) return null
      const part = options ? o.bytes.slice(options.range.offset, options.range.offset + options.range.length) : o.bytes
      return { size: o.bytes.length, contentType: o.contentType, stream: () => new Blob([part]).stream(), bytes: async () => part }
    },
    async put(k, value, options) {
      calls.push(`put ${k}`)
      const bytes = await bytesOf(value)
      objects.set(k, { bytes, contentType: options.contentType })
      return { size: bytes.length, etag: `"${k}"` }
    },
    async delete(k) {
      for (const key of typeof k === 'string' ? [k] : k) {
        calls.push(`delete ${key}`)
        objects.delete(key)
      }
    },
  }
  return { bucket, objects, calls }
}
