/** The old anonymous signing endpoint is intentionally retired. */
export function POST() {
  return Response.json(
    { error: 'Use the authenticated receipt upload flow' },
    { status: 410, headers: { 'Cache-Control': 'no-store' } },
  )
}
