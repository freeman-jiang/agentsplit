// The public answers that need no session: robots.txt, the sitemap, and the health checks.
import { SITEMAP_PATH } from '../shared/paths'

const TEXT = { 'Cache-Control': 'no-cache' }

/**
 * Only public pages are crawlable. Group pages live at top-level slugs, which
 * cannot be listed here, so everything else is disallowed. They need sign-in
 * in any case.
 */
export const robotsTxt = (baseUrl: string) =>
  new Response(
    ['User-agent: *', 'Allow: /$', 'Allow: /privacy', 'Allow: /sign-in', 'Disallow: /', `Sitemap: ${new URL(SITEMAP_PATH, baseUrl).href}`, ''].join('\n'),
    { headers: { ...TEXT, 'Content-Type': 'text/plain; charset=utf-8' } },
  )

export const sitemapXml = (baseUrl: string) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url>\n<loc>${new URL('/', baseUrl).href}</loc>\n<changefreq>yearly</changefreq>\n<priority>1</priority>\n</url>\n</urlset>\n`,
    { headers: { ...TEXT, 'Content-Type': 'application/xml; charset=utf-8' } },
  )

/** The health paths. Maintenance mode lets them through (maintenance.ts). */
export const HEALTH_PATHS = new Set(['/api/health', '/api/health/readiness', '/api/health/liveness'])

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
