import { groupPath, groupSlugSchema } from '@/lib/group-slug'
import { prisma } from '@/lib/prisma'
import { NextRequest, NextResponse } from 'next/server'

// Only routing happens here. Pages, route handlers and tRPC still authorize
// membership against immutable group IDs.
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const legacy = pathname.match(/^\/groups\/([A-Za-z0-9_-]{21})(\/.*)?$/)
  if (legacy) {
    // Next may route the rewritten destination through Proxy again. This
    // routing-only marker prevents redirecting it back to its public slug.
    // It grants no access: the destination always checks group membership.
    if (request.headers.get('x-agentsplit-group-rewrite') === legacy[1])
      return NextResponse.next()
    if (!['GET', 'HEAD'].includes(request.method)) return NextResponse.next()
    const group = await prisma.group.findUnique({
      where: { id: legacy[1] },
      select: { id: true, slug: true },
    })
    if (!group?.slug) return NextResponse.next()
    const url = request.nextUrl.clone()
    url.pathname = `${groupPath(group)}${legacy[2] ?? ''}`
    const response = NextResponse.redirect(url, 307)
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  }
  const [segment, ...rest] = pathname.slice(1).split('/')
  const slug = groupSlugSchema.safeParse(segment)
  if (!slug.success || !slug.data || slug.data !== segment)
    return NextResponse.next()
  const group = await prisma.group.findUnique({
    where: { slug: slug.data },
    select: { id: true },
  })
  if (!group) return NextResponse.next()
  const url = request.nextUrl.clone()
  url.pathname = `/groups/${group.id}/${rest.join('/') || 'expenses'}`
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-agentsplit-group-rewrite', group.id)
  return NextResponse.rewrite(url, { request: { headers: requestHeaders } })
}

export const config = {
  matcher: ['/((?!api/|_next/|.*\\.).*)'],
}
