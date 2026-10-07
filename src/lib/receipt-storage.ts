import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { MAX_RECEIPT_BYTES, publicUrl, storage } from './expense-uploads'
import { randomId } from './random'

export async function storeReceipt(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > MAX_RECEIPT_BYTES)
    throw new Error('Receipt must be at most 5 MiB')
  const image = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata()
  if (
    !image.width ||
    !image.height ||
    !['jpeg', 'png'].includes(image.format ?? '')
  )
    throw new Error('Use a valid JPEG or PNG image')
  const { client, bucket } = storage(),
    key = `receipts/${randomId()}.${image.format === 'jpeg' ? 'jpg' : 'png'}`
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: image.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      CacheControl: 'private,no-store',
    }),
  )
  return {
    id: randomId(),
    url: publicUrl(bucket, key),
    width: image.width,
    height: image.height,
  }
}
export async function readReceipt(url: string) {
  const { client, bucket } = storage()
  const prefix = publicUrl(bucket, '')
  if (!url.startsWith(prefix)) throw new Error('Invalid storage pointer')
  const key = url.slice(prefix.length)
  if (
    !key ||
    key.includes('..') ||
    key.includes('?') ||
    key.includes('#') ||
    key.includes('%')
  )
    throw new Error('Invalid storage pointer')
  return client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
}
