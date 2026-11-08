// The app's URL paths outside the SPA's routes, each built and matched here:
// the server routes them (src/server/main/app.ts), and the services, the MCP
// tools and the client build links to them. No Effect import: the client uses
// this module.
import { SECRET_TOKEN } from './ids'

/** The Effect RPC endpoint. Its client joins the base URL with a slash, so the server also answers `${RPC_PATH}/`. */
export const RPC_PATH = '/api/rpc'

/** Better Auth's base path, its default: sign-in, sessions, API keys and the OAuth provider. */
export const AUTH_PATH = '/api/auth'

/** The robots file and the sitemap, served by the server, not the SPA. */
export const ROBOTS_PATH = '/robots.txt'
export const SITEMAP_PATH = '/sitemap.xml'

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

/** The group exports as one file, JSON (the default) or CSV. */
export const FILE_EXPORT_FORMATS = ['json', 'csv'] as const
export type FileExportFormat = (typeof FILE_EXPORT_FORMATS)[number]
/** The group downloads: the file exports and the ZIP file of every receipt. */
export const EXPORT_FORMATS = [...FILE_EXPORT_FORMATS, 'receipts'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/** A group download, under the group's path (groupPath, or segmentPath on the client). */
export const exportPath = (data: { groupPath: string; format: ExportFormat }) => `${data.groupPath}/expenses/export/${data.format}`

const EXPORT_PREFIX = '^/(?:groups/)?([^/]+)/expenses/export/'
const EXPORT_ROUTE = new RegExp(`${EXPORT_PREFIX}(${EXPORT_FORMATS.join('|')})$`)

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

/**
 * Every path the server answers instead of the SPA, as Vite's dev proxy keys:
 * a plain key is a prefix, a key that starts with ^ is a regular expression.
 */
export const SERVER_PATHS = ['/api/', '/.well-known/', ROBOTS_PATH, SITEMAP_PATH, EXPORT_PREFIX] as const
