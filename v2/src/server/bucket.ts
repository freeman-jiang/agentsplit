// The receipts bucket, as receipts.ts and receipt-uploads.ts use it. The
// server implements it on Garage's S3 API (src/server/s3.ts); the database
// tests use an in-memory one (test/db/fake-bucket.ts).

/** A stored object. Read its bytes with one of the two calls, once. */
export type StoredObject = {
  /** The size of the whole object, also for a range read. */
  readonly size: number
  readonly contentType: string
  stream(): ReadableStream<Uint8Array>
  bytes(): Promise<Uint8Array>
}

export type Bucket = {
  /** The object, or null if there is none. With a range, the bytes are only that part. */
  get(key: string, options?: { readonly range: { readonly offset: number; readonly length: number } }): Promise<StoredObject | null>
  /** Stores the bytes, or the stream to its end. Returns the stored size and ETag. */
  put(key: string, body: Uint8Array | ReadableStream<Uint8Array>, options: { readonly contentType: string }): Promise<{ size: number; etag: string }>
  delete(keys: string | readonly string[]): Promise<void>
}
