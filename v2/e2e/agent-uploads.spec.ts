// An agent's receipt upload against the built Worker on workerd, with its local
// R2: the PUT body streams into the bucket, and update_expense reads the image
// header back from it. The database tests cover the refusals.
import { expect, test, type APIRequestContext } from '@playwright/test'
import { addExpense, agentKey, draft, seedHousehold } from './fixtures'

// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

type Target = { uploadId: string; url: string; method: string; headers: Record<string, string> }

/** One MCP tool call in the 2025 protocol; returns structuredContent, or fails with the error text. */
async function call(request: APIRequestContext, data: { key: string; name: string; args: object }): Promise<Record<string, unknown>> {
  const response = await request.post('/api/mcp', {
    headers: { 'x-api-key': data.key, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: data.name, arguments: data.args } },
  })
  const text = await response.text()
  const body = JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? text) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] } }
  if (!body.result?.structuredContent || body.result.isError) throw new Error(`${data.name} failed: ${response.status()} ${text}`)
  return body.result.structuredContent
}

test('an agent uploads a receipt to its target, attaches it, and downloads it with its key (P-TOOL-UPDATEEXP-11, 14, P-TOOL-GETEXP-06)', async ({ context, request, baseURL }) => {
  const household = await seedHousehold(context, baseURL ?? '')
  const key = await agentKey(household.owner.userId, baseURL ?? '')
  const expenseId = `agent-receipt-${Date.now()}`.padEnd(21, 'x').slice(0, 21)
  await addExpense(household, expenseId, draft(household, { title: 'Hardware store', amount: '42.00', date: '2026-11-01' }))

  const requested = await call(request, {
    key,
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

  const attached = await call(request, { key, name: 'update_expense', args: { groupId: household.groupId, expenseId, expectedRevision: 1, attachUploadIds: [target.uploadId] } })
  expect(attached['revision']).toBe(2)

  const read = await call(request, { key, name: 'get_expense', args: { groupId: household.groupId, expenseId } })
  const [document] = (read['expense'] as { documents: { width: number; height: number; downloadUrl: string }[] }).documents
  expect(document).toMatchObject({ width: 1, height: 1 })
  // The request fixture has no session cookie: only the agent's key authorizes the download.
  const download = await request.get(document?.downloadUrl ?? '', { headers: { 'x-api-key': key } })
  expect(download.status()).toBe(200)
  expect(download.headers()['content-type']).toBe('image/png')
  expect(Buffer.from(await download.body()).equals(PNG)).toBe(true)
})
