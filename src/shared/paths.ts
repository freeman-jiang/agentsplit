// The app's URL paths outside the SPA's routes, each built and matched here:
// the server routes them (src/server/main/app.ts), and the services, the MCP
// tools and the client build links to them. No Effect import: the client uses
// this module.
import { SECRET_TOKEN } from './ids'

/** A link on the app's origin, from a path of this module. */
export const absoluteUrl = (data: { baseUrl: string; path: string }) => `${new URL(data.baseUrl).origin}${data.path}`

/** GET (download) and POST (upload) of one receipt image. */
export const RECEIPTS_PATH = '/api/receipts'

/** Where the browser or an agent reads a receipt; access is checked on every read (P-RECEIPT-07). */
export const receiptDownloadPath = (data: { groupId: string; url: string }) => `${RECEIPTS_PATH}?${new URLSearchParams({ groupId: data.groupId, url: data.url })}`

const UPLOAD_PREFIX = '/api/receipt-uploads/'

/** An agent's upload target. The token in the path is the credential. */
export const receiptUploadPath = (token: string) => `${UPLOAD_PREFIX}${token}`

/** The token of an upload target path, or null for any other path. The token may be malformed; storeUpload refuses it then. */
export const receiptUploadTokenOf = (pathname: string) => {
  const token = pathname.startsWith(UPLOAD_PREFIX) ? pathname.slice(UPLOAD_PREFIX.length) : null
  return token && !token.includes('/') ? token : null
}

/** The group downloads: the CSV and JSON exports and the ZIP file of every receipt. */
export const EXPORT_FORMATS = ['csv', 'json', 'receipts'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/** A group download, under the group's path (groupPath, or segmentPath on the client). */
export const exportPath = (data: { groupPath: string; format: ExportFormat }) => `${data.groupPath}/expenses/export/${data.format}`

const EXPORT_ROUTE = new RegExp(`^/(?:groups/)?([^/]+)/expenses/export/(${EXPORT_FORMATS.join('|')})$`)

/**
 * The group reference and format of a download path: /groups/<id>/… or
 * /<slug>/…, as in the current app. A segment that does not decode stays as
 * typed: it names no group, so the membership check denies it.
 */
export function exportRouteOf(pathname: string): { readonly group: string; readonly format: ExportFormat } | null {
  const match = EXPORT_ROUTE.exec(pathname)
  const segment = match?.[1]
  const format = EXPORT_FORMATS.find((f) => f === match?.[2])
  if (segment === undefined || !format) return null
  try {
    return { group: decodeURIComponent(segment), format }
  } catch {
    return { group: segment, format }
  }
}

const INVITE_PREFIX = '/invite/'

/** An invitation link's path. The token is the secret. */
export const invitationPath = (token: string) => `${INVITE_PREFIX}${token}`

/** The token of an invitation link's path, or null. */
export const invitationTokenOfPath = (path: string) => {
  const token = path.startsWith(INVITE_PREFIX) ? path.slice(INVITE_PREFIX.length) : null
  return token !== null && SECRET_TOKEN.test(token) ? token : null
}

/** The page of one expense, also of an ungrouped expense's private context (P-UNGROUP-39). */
export const expensePagePath = (expenseId: string) => `/expenses/${encodeURIComponent(expenseId)}`
