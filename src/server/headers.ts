// Response headers: the security headers of each response, and the file name
// of a download. HTML documents, the static files and the receipt routes get
// the whole set; every other answer (JSON, event streams, redirects) gets the
// short API set. Each API answer leaves the VM, and bytes out are billed, so
// it carries no header that only a document reads.

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

/**
 * The security headers of an HTML document, a static file and a receipt
 * route. `receiptOrigin` is storage's origin in redirect mode
 * (RECEIPT_DOWNLOADS). The static files keep them: the service worker
 * (sw.js) runs under the policy of its own response.
 */
export const documentHeaders = (data: { receiptOrigin: string | undefined }): SecurityHeaders => ({
  'Content-Security-Policy': contentSecurityPolicy(data.receiptOrigin),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
})

/**
 * The security headers of every other answer, as the OWASP REST Security
 * Cheat Sheet gives them for an API: no sniffing, and a policy that loads
 * nothing and allows no frame, for a browser that opens an answer as a page.
 * Each route sets its own Cache-Control.
 */
export const API_HEADERS: SecurityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
}

/** True for an HTML document, such as the SPA page or the maintenance page. */
export const isHtml = (response: Response) => /^text\/html\b/i.test(response.headers.get('Content-Type') ?? '')

/**
 * A copy of `response` with the security `headers`; responses from fetch can
 * have immutable headers. A header the route set itself stays, such as the
 * sandbox policy of a receipt image. A response that has each header already
 * is returned as it is.
 */
export function secured(data: { response: Response; headers: SecurityHeaders }): Response {
  const missing = Object.entries(data.headers).filter(([name]) => !data.response.headers.has(name))
  if (missing.length === 0) return data.response
  const copy = new Response(data.response.body, data.response)
  for (const [name, value] of missing) copy.headers.set(name, value)
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
