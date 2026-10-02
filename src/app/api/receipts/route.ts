import { withGroupWrite } from '@/lib/expense-history'
import { getRuntimeFeatureFlags } from '@/lib/featureFlags'
import { authenticateMcp } from '@/lib/mcp/authenticate'
import { prisma } from '@/lib/prisma'
import { readReceipt, storeReceipt } from '@/lib/receipt-storage'
import { sessionPrincipal } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const fail = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } })
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams,
    groupId = params.get('groupId'),
    url = params.get('url')
  if (!groupId || !url) return fail(400, 'Receipt reference is required')
  const principal = request.headers.has('authorization')
    ? await authenticateMcp(request).then((result) =>
        'principal' in result ? result.principal : undefined,
      )
    : await sessionPrincipal(request.headers)
  if (!principal) return fail(401, 'Authentication required')
  if (!principal.groupIds.includes(groupId))
    return fail(403, 'Group access denied')
  if (
    !(await prisma.receiptObject.findUnique({
      where: { groupId_url: { groupId, url } },
    }))
  )
    return fail(404, 'Receipt not found')
  try {
    const object = await readReceipt(url)
    const bytes = await object.Body?.transformToByteArray()
    if (!bytes) return fail(404, 'Receipt not found')
    return new Response(Buffer.from(bytes), {
      headers: {
        'Content-Type':
          object.ContentType === 'image/png' ? 'image/png' : 'image/jpeg',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Disposition': 'inline',
      },
    })
  } catch {
    return fail(404, 'Receipt not found')
  }
}
export async function POST(request: Request) {
  if (
    request.headers.get('origin') !==
    new URL(process.env.BASE_URL || request.url).origin
  )
    return fail(403, 'Origin not allowed')
  const principal = await sessionPrincipal(request.headers)
  if (!principal) return fail(401, 'Authentication required')
  if (!(await getRuntimeFeatureFlags()).enableExpenseDocuments)
    return fail(403, 'Receipts are disabled')
  // Cap the multipart envelope before parsing the body.
  const length = Number(request.headers.get('content-length'))
  if (!length || length > 5 * 1024 * 1024 + 65536)
    return fail(413, 'Receipt must be at most 5 MiB')
  try {
    const form = await request.formData(),
      groupId = form.get('groupId'),
      file = form.get('file')
    if (typeof groupId !== 'string' || !(file instanceof File))
      return fail(400, 'Group and image are required')
    if (!principal.groupIds.includes(groupId))
      return fail(403, 'Group access denied')
    const document = await withGroupWrite(
      groupId,
      async (tx) => {
        const doc = await storeReceipt(new Uint8Array(await file.arrayBuffer()))
        await tx.receiptObject.create({
          data: {
            id: doc.id,
            groupId,
            url: doc.url,
            createdBy: principal.userId,
          },
        })
        return doc
      },
      principal,
    )
    return Response.json(document, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return fail(
      400,
      'Could not upload receipt. Use a JPEG or PNG image up to 5 MiB.',
    )
  }
}
