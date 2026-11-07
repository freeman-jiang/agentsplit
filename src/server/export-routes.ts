// The CSV and JSON downloads at the current app's URLs:
// /groups/<id>/expenses/export/<format> and /<slug>/expenses/export/<format>.
// The web session, an API key or an OAuth access token with read scope may
// download them (P-EXPORT-05, P-TOOL-EXPORT-06). The files are built in export.ts.
import { httpReader } from './auth/authenticate'
import type { Db } from './core/db'
import { exportCsv, exportJson } from './export'
import { domainErrorResponse } from './core/errors'
import { contentDisposition } from './headers'

export async function downloadExport(data: { db: Db; request: Request; group: string; format: 'csv' | 'json'; baseUrl: string; secret: string }): Promise<Response> {
  const reader = await httpReader(data.db, { request: data.request, baseUrl: data.baseUrl, secret: data.secret, signIn: 'Sign in required' })
  if ('response' in reader) return reader.response
  try {
    const file = await (data.format === 'json' ? exportJson : exportCsv)(data.db, { principal: reader.principal, groupId: data.group })
    return new Response(file.content, {
      // Downloads stay out of shared caches, as in the current app.
      headers: { 'Cache-Control': 'private, no-store', 'Content-Type': file.contentType, 'Content-Disposition': contentDisposition(file.filename) },
    })
  } catch (error) {
    return domainErrorResponse(error)
  }
}
