import { createHash } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { TRPCError } from '@trpc/server'
import sharp from 'sharp'
import { z } from 'zod'
import { env } from './env'
import type { AuditActor } from './expense-history'
import { getRuntimeFeatureFlags } from './featureFlags'
import { randomId } from './random'

export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024
export const uploadRequestSchema = z.strictObject({
  filename: z.string().min(1).max(255),
  contentType: z.enum(['image/jpeg', 'image/png']),
  bytes: z.number().int().min(1).max(MAX_RECEIPT_BYTES),
})
export const uploadRequestsSchema = z.array(uploadRequestSchema).max(10)
export const uploadIdsSchema = z
  .array(z.string().regex(/^[A-Za-z0-9_-]{21}$/))
  .max(10)
export type UploadRequest = z.infer<typeof uploadRequestSchema>
export type UploadTarget = {
  uploadId: string
  filename: string
  url: string
  method: 'PUT'
  headers: Record<string, string>
  expiresAt: string
}
export const uploadTargetSchema = z.object({
  uploadId: z.string(),
  filename: z.string(),
  url: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
})

export function storage() {
  if (
    !env.S3_UPLOAD_KEY ||
    !env.S3_UPLOAD_SECRET ||
    !env.S3_UPLOAD_BUCKET ||
    !env.S3_UPLOAD_REGION
  )
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Receipt storage is not configured',
    })
  return {
    bucket: env.S3_UPLOAD_BUCKET,
    client: new S3Client({
      region: env.S3_UPLOAD_REGION,
      endpoint: env.S3_UPLOAD_ENDPOINT,
      forcePathStyle: !!env.S3_UPLOAD_ENDPOINT,
      credentials: {
        accessKeyId: env.S3_UPLOAD_KEY,
        secretAccessKey: env.S3_UPLOAD_SECRET,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    }),
  }
}
const targetHash = (actor: AuditActor, groupId: string, expenseId: string) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        'agentsplit-upload-v1',
        actor.userId,
        groupId,
        expenseId,
      ]),
    )
    .digest('hex')
const stagedKey = (id: string) => `pending-receipts/${id}`
export function publicUrl(bucket: string, key: string) {
  const endpoint =
    env.S3_UPLOAD_ENDPOINT?.replace(/\/$/, '') ??
    `https://${bucket}.s3.${env.S3_UPLOAD_REGION}.amazonaws.com`
  return env.S3_UPLOAD_ENDPOINT
    ? `${endpoint}/${bucket}/${key}`
    : `${endpoint}/${key}`
}

/** Optional capability after a successful write. Signing does not create a receipt. */
export async function prepareExpenseUploads(
  actor: AuditActor | undefined,
  groupId: string,
  expenseId: string,
  requests: UploadRequest[] = [],
) {
  if (!requests.length)
    return { uploads: [] as UploadTarget[], uploadError: null as string | null }
  try {
    if (!actor)
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Agent authentication is required for direct receipt uploads',
      })
    if (!(await getRuntimeFeatureFlags()).enableExpenseDocuments)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Receipts are disabled',
      })
    const { client, bucket } = storage()
    const uploads: UploadTarget[] = []
    for (const file of requests) {
      const uploadId = randomId()
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: stagedKey(uploadId),
          ContentType: file.contentType,
          ContentLength: file.bytes,
          Metadata: {
            target: targetHash(actor, groupId, expenseId),
            filename: Buffer.from(file.filename).toString('base64url'),
          },
        }),
        { expiresIn: 300 },
      )
      uploads.push({
        uploadId,
        filename: file.filename,
        url,
        method: 'PUT',
        headers: {
          'Content-Type': file.contentType,
          'Content-Length': String(file.bytes),
        },
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      })
    }
    return { uploads, uploadError: null }
  } catch {
    // The expense is already committed. Never report the core write as failed.
    return {
      uploads: [] as UploadTarget[],
      uploadError:
        'Expense saved, but upload targets could not be prepared. Retry update_expense with the current revision and upload requests.',
    }
  }
}

export type FinalizedUploads = {
  documents: { id: string; url: string; width: number; height: number }[]
  permanentKeys: string[]
  temporaryKeys: string[]
}
/** Resolve only scoped staging IDs, not arbitrary URLs. Final objects never receive PUT URLs. */
export async function finalizeExpenseUploads(
  actor: AuditActor | undefined,
  groupId: string,
  expenseId: string,
  ids: string[],
): Promise<FinalizedUploads> {
  const result: FinalizedUploads = {
    documents: [],
    permanentKeys: [],
    temporaryKeys: [],
  }
  if (!ids.length) return result
  if (!actor)
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Agent authentication is required for direct receipt uploads',
    })
  if (!(await getRuntimeFeatureFlags()).enableExpenseDocuments)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Receipts are disabled',
    })
  const { client, bucket } = storage()
  try {
    for (const id of new Set(ids)) {
      const key = stagedKey(id)
      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      )
      if (head.Metadata?.target !== targetHash(actor, groupId, expenseId))
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'This upload does not belong to this user and expense',
        })
      if (
        !head.ContentLength ||
        head.ContentLength > MAX_RECEIPT_BYTES ||
        !head.LastModified ||
        Date.now() - head.LastModified.getTime() > 86_400_000
      )
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Upload is too large or expired',
        })
      const object = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, IfMatch: head.ETag }),
      )
      const bytes = await object.Body?.transformToByteArray()
      if (!bytes || bytes.length !== head.ContentLength)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Upload is incomplete',
        })
      const image = await sharp(bytes, {
        limitInputPixels: 40_000_000,
      }).metadata()
      if (
        !image.width ||
        !image.height ||
        !['jpeg', 'png'].includes(image.format ?? '') ||
        image.width * image.height > 40_000_000
      )
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Receipts must be valid JPEG or PNG images',
        })
      const permanent = `receipts/${randomId()}.${image.format === 'jpeg' ? 'jpg' : 'png'}`
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: permanent,
          Body: bytes,
          ContentType: image.format === 'jpeg' ? 'image/jpeg' : 'image/png',
          CacheControl: 'private,no-store',
        }),
      )
      result.permanentKeys.push(permanent)
      result.temporaryKeys.push(key)
      result.documents.push({
        id: randomId(),
        url: publicUrl(bucket, permanent),
        width: image.width,
        height: image.height,
      })
    }
    return result
  } catch (error) {
    await cleanupReceiptKeys(result.permanentKeys)
    if (error instanceof TRPCError) throw error
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'Receipt upload could not be finalized. Upload the file first, then retry with its uploadId.',
    })
  }
}
export async function cleanupReceiptKeys(keys: string[]) {
  if (!keys.length) return
  try {
    const { client, bucket } = storage()
    // Cleanup is best effort and cannot turn a committed expense into a failed write.
    await Promise.allSettled(
      keys.map((Key) =>
        client.send(new DeleteObjectCommand({ Bucket: bucket, Key })),
      ),
    )
  } catch {
    /* Best-effort cleanup never changes a committed result. */
  }
}
