/** @jest-environment node */
import { createHash } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import sharp from 'sharp'
import {
  finalizeExpenseUploads,
  MAX_RECEIPT_BYTES,
  prepareExpenseUploads,
} from './expense-uploads'

jest.mock('./random', () => ({
  randomId: () =>
    require('node:crypto').randomBytes(16).toString('hex').slice(0, 21),
}))
var mockSend = jest.fn(),
  mockSign = jest.fn()
jest.mock('@aws-sdk/client-s3', () => ({
  ...jest.requireActual('@aws-sdk/client-s3'),
  S3Client: class {
    send(...args: unknown[]) {
      return mockSend(...args)
    }
  },
}))
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockSign(...args),
}))
jest.mock('./env', () => ({
  env: {
    S3_UPLOAD_KEY: 'test-key',
    S3_UPLOAD_SECRET: 'test-secret',
    S3_UPLOAD_BUCKET: 'test-bucket',
    S3_UPLOAD_REGION: 'garage',
    S3_UPLOAD_ENDPOINT: 'https://storage.test',
  },
}))
jest.mock('./featureFlags', () => ({
  getRuntimeFeatureFlags: async () => ({ enableExpenseDocuments: true }),
}))
const actor = { userId: 'owner', connectionId: 'key' },
  groupId = 'group',
  expenseId = 'expense'
const ownerHash = createHash('sha256')
  .update(
    JSON.stringify(['agentsplit-upload-v1', actor.userId, groupId, expenseId]),
  )
  .digest('hex')
let png: Buffer
beforeAll(async () => {
  png = await sharp({
    create: { width: 2, height: 3, channels: 3, background: '#f00' },
  })
    .png()
    .toBuffer()
})
beforeEach(() => {
  mockSend.mockReset()
  mockSign.mockReset().mockResolvedValue('https://storage.test/signed')
})
function storageWith(target = ownerHash, bytes: Uint8Array = png) {
  mockSend.mockImplementation(async (command) => {
    if (command instanceof HeadObjectCommand)
      return {
        ContentLength: bytes.length,
        LastModified: new Date(),
        ETag: '"test-etag"',
        Metadata: { target },
      }
    if (command instanceof GetObjectCommand)
      return { Body: { transformToByteArray: async () => bytes } }
    return {}
  })
}
it('offers scoped, bounded upload targets without uploading or attaching anything', async () => {
  const result = await prepareExpenseUploads(actor, groupId, expenseId, [
    { filename: 'receipt.png', contentType: 'image/png', bytes: png.length },
  ])
  expect(result.uploads).toHaveLength(1)
  expect(mockSend).not.toHaveBeenCalled()
  const command = mockSign.mock.calls[0][1] as PutObjectCommand
  expect(command.input.ContentLength).toBe(png.length)
  expect(command.input.Metadata?.target).toBe(ownerHash)
  expect(command.input.Key).toMatch(/^pending-receipts\//)
  expect(await prepareExpenseUploads(actor, groupId, expenseId)).toEqual({
    uploads: [],
    uploadError: null,
  })
})
it('reports optional target failure without claiming the saved expense failed', async () => {
  mockSign.mockRejectedValue(new Error('private signing diagnostics'))
  const result = await prepareExpenseUploads(actor, groupId, expenseId, [
    { filename: 'receipt.png', contentType: 'image/png', bytes: 50 },
  ])
  expect(result.uploads).toEqual([])
  expect(result.uploadError).toContain('Expense saved')
  expect(result.uploadError).not.toContain('private signing diagnostics')
})
it('validates bytes and gives finalized receipts new permanent URLs', async () => {
  storageWith()
  const result = await finalizeExpenseUploads(actor, groupId, expenseId, [
    'a'.repeat(21),
  ])
  expect(result.documents[0]).toEqual(
    expect.objectContaining({
      width: 2,
      height: 3,
      url: expect.stringMatching(
        /^https:\/\/storage.test\/test-bucket\/receipts\//,
      ),
    }),
  )
  expect(
    mockSend.mock.calls.some(([c]) => c instanceof DeleteObjectCommand),
  ).toBe(false)
  const put = mockSend.mock.calls.find(
    ([c]) => c instanceof PutObjectCommand,
  )?.[0] as PutObjectCommand
  expect(Buffer.from(put.input.Body as Uint8Array)).toEqual(png)
  expect(put.input.ContentType).toBe('image/png')
})
it('rejects another user or expense upload before reading bytes', async () => {
  storageWith('wrong-owner')
  await expect(
    finalizeExpenseUploads(actor, groupId, expenseId, ['b'.repeat(21)]),
  ).rejects.toThrow('does not belong')
  expect(mockSend.mock.calls.some(([c]) => c instanceof GetObjectCommand)).toBe(
    false,
  )
})
it('rejects oversized and malformed images', async () => {
  storageWith()
  mockSend.mockResolvedValueOnce({
    Metadata: { target: ownerHash },
    ContentLength: MAX_RECEIPT_BYTES + 1,
    LastModified: new Date(),
  })
  await expect(
    finalizeExpenseUploads(actor, groupId, expenseId, ['c'.repeat(21)]),
  ).rejects.toThrow('too large')
  storageWith(ownerHash, Buffer.from('not an image'))
  await expect(
    finalizeExpenseUploads(actor, groupId, expenseId, ['d'.repeat(21)]),
  ).rejects.toThrow('could not be finalized')
})
it('cleans only new permanent copies if finalizing a later file fails', async () => {
  storageWith()
  let heads = 0
  const send = mockSend.getMockImplementation()!
  mockSend.mockImplementation((command) =>
    command instanceof HeadObjectCommand && ++heads === 2
      ? Promise.resolve({ Metadata: { target: 'other' } })
      : send(command),
  )
  await expect(
    finalizeExpenseUploads(actor, groupId, expenseId, [
      'e'.repeat(21),
      'f'.repeat(21),
    ]),
  ).rejects.toThrow('does not belong')
  const removed = mockSend.mock.calls
    .filter(([c]) => c instanceof DeleteObjectCommand)
    .map(([c]) => c.input.Key)
  expect(removed).toHaveLength(1)
  expect(removed[0]).toMatch(/^receipts\//)
})
