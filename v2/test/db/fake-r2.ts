// An in-memory stand-in for the R2 binding, with only the calls that
// receipts.ts and receipt-uploads.ts make. Like R2, put reads a stream to its
// end and reports the stored size, and get can read a byte range.

type Stored = { bytes: Uint8Array<ArrayBuffer>; contentType: string }

async function bytesOf(value: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (value instanceof Uint8Array) return value
  return new Uint8Array(await new Response(value).arrayBuffer())
}

export function fakeBucket() {
  const objects = new Map<string, Stored>()
  const calls: string[] = []
  const bucket = {
    async get(k: string, options?: { range?: { offset: number; length: number } }) {
      calls.push(`get ${k}`)
      const o = objects.get(k)
      if (!o) return null
      const part = options?.range ? o.bytes.slice(options.range.offset, options.range.offset + options.range.length) : o.bytes
      return {
        size: o.bytes.length,
        body: new Blob([part]).stream(),
        arrayBuffer: async () => part.buffer,
        httpMetadata: { contentType: o.contentType },
      }
    },
    async put(k: string, value: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>, options: { httpMetadata: { contentType: string } }) {
      calls.push(`put ${k}`)
      const bytes = await bytesOf(value)
      objects.set(k, { bytes, contentType: options.httpMetadata.contentType })
      return { size: bytes.length, httpEtag: `"${k}"` }
    },
    async delete(k: string | string[]) {
      for (const key of typeof k === 'string' ? [k] : k) {
        calls.push(`delete ${key}`)
        objects.delete(key)
      }
    },
  }
  // The binding's full type has many members the code never calls; the fake implements those it does.
  return { bucket: bucket as unknown as R2Bucket, objects, calls }
}
