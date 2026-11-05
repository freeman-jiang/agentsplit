// Security headers for every response, the static files and the SPA page included.

/**
 * No inline or eval scripts: the SPA is one module bundle, and the theme and
 * service-worker scripts are files. Inline styles stay allowed, because the
 * UI components set style attributes. Receipts are served from this origin.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
}

/** A copy of `response` with the security headers; responses from fetch can have immutable headers. */
export function secured(response: Response): Response {
  if (response.status === 101) return response
  const copy = new Response(response.body, response)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) copy.headers.set(name, value)
  return copy
}

export const noStore = { 'Cache-Control': 'no-store' } as const

/** A JSON error body `{error}`, as the current app answers, kept out of caches. */
export const jsonError = (data: { status: number; message: string; headers?: Record<string, string> }) =>
  Response.json({ error: data.message }, { status: data.status, headers: { ...noStore, ...data.headers } })

/** Is the request from the app's own origin? The session cookie alone must not authorize a cross-site write. */
export const sameOrigin = (request: Request, baseUrl: string) => request.headers.get('origin') === new URL(baseUrl).origin

const TEXT = { 'Cache-Control': 'no-cache' }

/**
 * Only public pages are crawlable. Group pages live at top-level slugs, which
 * cannot be listed here, so everything else is disallowed. They need sign-in
 * in any case.
 */
export const robotsTxt = (baseUrl: string) =>
  new Response(
    ['User-agent: *', 'Allow: /$', 'Allow: /privacy', 'Allow: /sign-in', 'Disallow: /', `Sitemap: ${new URL('/sitemap.xml', baseUrl).href}`, ''].join('\n'),
    { headers: { ...TEXT, 'Content-Type': 'text/plain; charset=utf-8' } },
  )

export const sitemapXml = (baseUrl: string) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url>\n<loc>${new URL('/', baseUrl).href}</loc>\n<changefreq>yearly</changefreq>\n<priority>1</priority>\n</url>\n</urlset>\n`,
    { headers: { ...TEXT, 'Content-Type': 'application/xml; charset=utf-8' } },
  )

const HEALTH_HEADERS = { 'Cache-Control': 'no-cache, no-store, must-revalidate' }

/** Readiness runs `checkDatabase`. The cause of a failure goes to the log, never to the caller. */
export async function readinessResponse(checkDatabase: () => Promise<void>): Promise<Response> {
  try {
    await checkDatabase()
    return Response.json({ status: 'healthy', services: { database: { status: 'healthy' } } }, { headers: HEALTH_HEADERS })
  } catch (error) {
    console.error('Readiness check failed', error)
    return Response.json({ status: 'unhealthy', services: { database: { status: 'unhealthy' } } }, { status: 503, headers: HEALTH_HEADERS })
  }
}

export const livenessResponse = () => Response.json({ status: 'healthy' }, { headers: HEALTH_HEADERS })
