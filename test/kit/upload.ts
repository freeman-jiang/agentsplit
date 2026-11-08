// A browser's receipt upload to POST /api/receipts.

/**
 * The multipart request a browser sends. A browser sets Content-Length on a
 * multipart body and Node's Request does not, so it is set here; `length`
 * overrides it.
 */
export async function receiptUpload(data: {
  baseUrl: string
  groupId: string
  file: Uint8Array<ArrayBuffer>
  type?: string
  origin?: string
  length?: number
  cookie?: string
}): Promise<Request> {
  const form = new FormData()
  form.set('groupId', data.groupId)
  form.set('file', new File([data.file], 'receipt.png', { type: data.type ?? 'image/png' }))
  const encoded = new Request(data.baseUrl, { method: 'POST', body: form })
  const body = await encoded.arrayBuffer()
  return new Request(new URL('/api/receipts', data.baseUrl), {
    method: 'POST',
    body,
    headers: {
      origin: data.origin ?? data.baseUrl,
      'content-type': encoded.headers.get('content-type') ?? '',
      'content-length': String(data.length ?? body.byteLength),
      ...(data.cookie ? { cookie: data.cookie } : {}),
    },
  })
}
