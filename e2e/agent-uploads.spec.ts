// Receipt uploads against the built server and a real Garage: an agent's PUT
// body streams into the bucket, and update_expense reads the image header back
// from it; a member's browser upload is stored and served back, also to an
// <img> on the app's page. The database tests cover the refusals.
import { expect, test } from '@playwright/test'
import { randomId } from '../src/shared/ids'
import { png } from '../test/kit/images'
import { mcpClient } from '../test/kit/mcp'
import { addExpense, agentKey, draft, seedHousehold } from './fixtures'

const PNG = Buffer.from(png({ width: 1, height: 1 }))
/** A whole 1 × 1 PNG: PNG is only a header, which a browser cannot draw. */
const WHOLE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

type Target = { uploadId: string; url: string; method: string; headers: Record<string, string> }

test('an agent uploads a receipt to its target, attaches it, and downloads it with its key (P-TOOL-UPDATEEXP-11, 14, P-TOOL-GETEXP-06)', async ({ context, request, baseURL }) => {
  const household = await seedHousehold(context, baseURL ?? '')
  const key = await agentKey(household.owner.userId, baseURL ?? '')
  // The agent's own HTTP client, over the network to the built server.
  const mcp = mcpClient({ baseUrl: baseURL ?? '', send: (r) => fetch(r) })
  const call = (data: { name: string; args: object }) => mcp.ok({ ...data, headers: { 'x-api-key': key } })
  const expenseId = randomId()
  await addExpense(household, expenseId, draft(household, { title: 'Hardware store', amount: '42.00', date: '2026-11-01' }))

  const requested = await call({
    name: 'update_expense',
    args: { groupId: household.groupId, expenseId, expectedRevision: 1, uploads: [{ filename: 'receipt.png', contentType: 'image/png', bytes: PNG.length }] },
  })
  expect(requested['revision']).toBe(1)
  const [target] = requested['uploads'] as Target[]
  if (!target) throw new Error('no upload target')
  expect(target.url.startsWith(`${baseURL}/api/receipt-uploads/`)).toBe(true)

  // The agent's PUT: only the target's headers, no API key.
  const put = await request.put(target.url, { headers: target.headers, data: PNG })
  expect(put.status()).toBe(200)
  expect((await request.put(target.url, { headers: target.headers, data: PNG })).status()).toBe(403)

  const attached = await call({ name: 'update_expense', args: { groupId: household.groupId, expenseId, expectedRevision: 1, attachUploadIds: [target.uploadId] } })
  expect(attached['revision']).toBe(2)

  const read = await call({ name: 'get_expense', args: { groupId: household.groupId, expenseId } })
  const [document] = (read['expense'] as { documents: { width: number; height: number; downloadUrl: string }[] }).documents
  expect(document).toMatchObject({ width: 1, height: 1 })
  // The request fixture has no session cookie: only the agent's key authorizes the download.
  const download = await request.get(document?.downloadUrl ?? '', { headers: { 'x-api-key': key } })
  expect(download.status()).toBe(200)
  expect(download.headers()['content-type']).toBe('image/png')
  expect(Buffer.from(await download.body()).equals(PNG)).toBe(true)
})

test('a member uploads a receipt from the browser and downloads it (P-RECEIPT-07)', async ({ context, page, baseURL }) => {
  const household = await seedHousehold(context, baseURL ?? '')
  // context.request sends the browser's session cookie.
  const upload = await context.request.post('/api/receipts', {
    headers: { origin: baseURL ?? '' },
    multipart: { groupId: household.groupId, file: { name: 'receipt.png', mimeType: 'image/png', buffer: WHOLE_PNG } },
  })
  expect(upload.status()).toBe(200)
  const stored = (await upload.json()) as { url: string; width: number; height: number }
  expect(stored).toMatchObject({ width: 1, height: 1 })
  const path = `/api/receipts?${new URLSearchParams({ groupId: household.groupId, url: stored.url })}`
  const download = await context.request.get(path)
  expect(download.status()).toBe(200)
  expect(download.headers()['content-type']).toBe('image/png')
  expect(Buffer.from(await download.body()).equals(WHOLE_PNG)).toBe(true)
  // With RECEIPT_DOWNLOADS=redirect the image comes from Garage's origin, which the page's policy must allow.
  await page.goto('/')
  const width = await page.evaluate(
    (src) =>
      new Promise<number>((resolve) => {
        const image = new Image()
        image.onload = () => resolve(image.naturalWidth)
        image.onerror = () => resolve(0)
        image.src = src
      }),
    path,
  )
  expect(width).toBe(1)
})
