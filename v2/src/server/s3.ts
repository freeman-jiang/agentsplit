// The receipts bucket on an S3 API (Garage in production), with Bun's built-in
// S3 client. It signs with SigV4, uses path-style URLs, and streams uploads.
import { S3Client } from 'bun'
import type { Bucket } from './bucket'

const notFound = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'NoSuchKey'

export function s3Bucket(config: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }): Bucket {
  const client = new S3Client({ ...config, virtualHostedStyle: false })
  return {
    async get(key, options) {
      const file = client.file(key)
      let stat
      try {
        stat = await file.stat()
      } catch (error) {
        if (notFound(error)) return null
        throw error
      }
      const part = options ? file.slice(options.range.offset, options.range.offset + options.range.length) : file
      return { size: stat.size, contentType: stat.type, stream: () => part.stream(), bytes: () => part.bytes() }
    },
    async put(key, body, options) {
      const file = client.file(key)
      // A Response lets the client stream the body; it sends a large one in parts.
      await file.write(body instanceof Uint8Array ? body : new Response(body), { type: options.contentType })
      const stat = await file.stat()
      return { size: stat.size, etag: stat.etag }
    },
    async delete(keys) {
      for (const key of typeof keys === 'string' ? [keys] : keys) await client.delete(key)
    },
  }
}
