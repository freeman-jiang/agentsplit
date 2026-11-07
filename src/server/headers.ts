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
  const copy = new Response(response.body, response)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) copy.headers.set(name, value)
  return copy
}
