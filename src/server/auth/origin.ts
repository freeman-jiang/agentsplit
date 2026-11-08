// The one origin rule for requests a browser can send. A request that names
// its origin must come from the app's own origin; a write that a session
// cookie authorizes must name it, so the cookie alone never authorizes a
// cross-site write. Agents send no Origin header.

export function originAllowed(data: { request: Request; baseUrl: string; cookieWrite: boolean }): boolean {
  const origin = data.request.headers.get('origin')
  return origin === null ? !data.cookieWrite : origin === new URL(data.baseUrl).origin
}
