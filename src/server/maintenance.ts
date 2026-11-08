// The cutover's freeze (docs/v2/CUTOVER.md). With AGENTSPLIT_MAINTENANCE set,
// the server answers every request except the health checks with 503, so the
// container can start, migrate and pass Coolify's health check while users
// see a maintenance page and nothing writes to the database.
import { HEALTH_PATHS } from './public-pages'

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentSplit · Maintenance</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>AgentSplit is down for maintenance</h1><p>Your data is safe. Try again in a few minutes.</p></body></html>`

/** The maintenance answer for a request, or null when the request may run. */
export function maintenanceResponse(request: Request): Response | null {
  if (HEALTH_PATHS.has(new URL(request.url).pathname)) return null
  const json = request.headers.get('accept')?.includes('text/html') !== true
  const headers = { 'Cache-Control': 'no-store', 'Retry-After': '300' }
  return json
    ? Response.json({ error: 'AgentSplit is down for maintenance. Try again in a few minutes.' }, { status: 503, headers })
    : new Response(PAGE, { status: 503, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } })
}
