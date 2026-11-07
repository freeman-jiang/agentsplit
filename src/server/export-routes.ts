// The CSV and JSON downloads at the current app's URLs:
// /groups/<id>/expenses/export/<format> and /<slug>/expenses/export/<format>.
// The web session, an API key or an OAuth access token with read scope may
// download them (P-EXPORT-05, P-TOOL-EXPORT-06). The files are built in export.ts.
import { GROUP_DENIED } from '../shared/errors'
import { httpReader } from './auth/authenticate'
import type { Db } from './core/db'
import { exportCsv, exportJson } from './export'
import { domainErrorResponse, jsonError } from './core/errors'

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

export async function downloadExport(data: { db: Db; request: Request; group: string; format: 'csv' | 'json'; baseUrl: string; secret: string }): Promise<Response> {
  const reader = await httpReader(data.db, { request: data.request, baseUrl: data.baseUrl, secret: data.secret, signIn: 'Sign in required' })
  if ('response' in reader) return reader.response
  let groupId: string
  try {
    groupId = decodeURIComponent(data.group)
  } catch {
    return jsonError({ status: 403, message: GROUP_DENIED })
  }
  try {
    const file = await (data.format === 'json' ? exportJson : exportCsv)(data.db, { principal: reader.principal, groupId })
    return new Response(file.content, {
      // Downloads stay out of shared caches, as in the current app.
      headers: { 'Cache-Control': 'private, no-store', 'Content-Type': file.contentType, 'Content-Disposition': contentDisposition(file.filename) },
    })
  } catch (error) {
    return domainErrorResponse(error)
  }
}
