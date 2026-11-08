// The receipts bucket, as receipts.ts and receipt-uploads.ts use it. The
// server implements it on Garage's S3 API (src/server/s3.ts); the database
// tests use an in-memory one (test/db/fake-bucket.ts).
import { Unavailable } from '../shared/api'
import { UNAVAILABLE } from '../shared/errors'

/** A stored object. Read its bytes with one of the two calls, once. */
export type StoredObject = {
  /** The size of the whole object, also for a range read. */
  readonly size: number
  readonly contentType: string
  stream(): ReadableStream<Uint8Array>
  bytes(): Promise<Uint8Array>
}

/** The answer to a failed storage call: the cause is logged, never sent. */
export const storageUnavailable = (data: { what: string; error: unknown }) => {
  console.error(`${data.what} failed`, data.error)
  return new Unavailable({ message: UNAVAILABLE })
}

/** Removes objects that no row names any more. A failure is logged with the keys, so the objects can be found. */
export const removeOrphans = (bucket: Bucket, keys: readonly string[]) =>
  bucket.delete(keys).catch((error: unknown) => console.error('Removing unregistered receipt objects failed', { keys }, error))

export type Bucket = {
  /** The object, or null if there is none. With a range, the bytes are only that part. */
  get(key: string, options?: { readonly range: { readonly offset: number; readonly length: number } }): Promise<StoredObject | null>
  /** Stores the bytes, or the stream to its end. Returns the stored size and ETag. */
  put(key: string, body: Uint8Array | ReadableStream<Uint8Array>, options: { readonly contentType: string }): Promise<{ size: number; etag: string }>
  delete(keys: string | readonly string[]): Promise<void>
}
