// Response headers: the security headers of every response (the static files
// and the SPA page included), and the file name of a download.

/**
 * No inline or eval scripts: the SPA is one module bundle, and the theme and
 * service-worker scripts are files. Inline styles stay allowed, because the
 * UI components set style attributes. Receipts load from this origin, and
 * from `receiptOrigin` when /api/receipts redirects to storage.
 */
const contentSecurityPolicy = (receiptOrigin: string | undefined) =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${receiptOrigin ? ` ${receiptOrigin}` : ''}`,
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')

export type SecurityHeaders = Readonly<Record<string, string>>

/** The security headers of every response. `receiptOrigin` is storage's origin in redirect mode (RECEIPT_DOWNLOADS). */
export const securityHeaders = (data: { receiptOrigin: string | undefined }): SecurityHeaders => ({
  'Content-Security-Policy': contentSecurityPolicy(data.receiptOrigin),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
})

/**
 * A copy of `response` with the security `headers`; responses from fetch can
 * have immutable headers. A header the route set itself stays, such as the
 * sandbox policy of a receipt image.
 */
export function secured(data: { response: Response; headers: SecurityHeaders }): Response {
  const copy = new Response(data.response.body, data.response)
  for (const [name, value] of Object.entries(data.headers)) if (!copy.headers.has(name)) copy.headers.set(name, value)
  return copy
}

/** RFC 6266 Content-Disposition, as the `content-disposition` package writes it. */
export function contentDisposition(name: string): string {
  // A path separator in a group name would make some clients drop the part before it.
  const safe = name.replace(/[/\\]/g, '_')
  const fallback = safe.replace(/[^\x20-\x7e]/g, '_')
  const quoted = `"${fallback.replace(/([\\"])/g, '\\$1')}"`
  if (fallback === safe) return `attachment; filename=${quoted}`
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename=${quoted}; filename*=UTF-8''${encoded}`
}
