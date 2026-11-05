// The current app's group URL redirects (src/proxy.ts at bb26b78), answered
// before the SPA page. The client's router keeps the URLs as typed
// (src/client/group-urls.ts).
import { sql } from 'drizzle-orm'
import { groupPath, isIdSegment } from '../shared/groups'
import { GROUP_ID } from '../shared/ids'
import type { Db } from './db'

export type IdPath = {
  readonly id: string
  /** The rest of the path after the ID, with its leading slash, or ''. */
  readonly rest: string
  /** True for /groups/<id>/…, the current app's form; false for /<id>/…, v2's first form. */
  readonly prefixed: boolean
}

/** The group ID that a page path names, or null if the path names no group by ID. */
export function idPathOf(pathname: string): IdPath | null {
  const match = /^\/(groups\/)?([^/]+)(\/.*)?$/.exec(pathname)
  if (!match) return null
  const [, prefix, id = '', rest = ''] = match
  // A slug path is never read as an ID: /<slug> pages stay where they are.
  if (!GROUP_ID.test(id) || (prefix === undefined && !isIdSegment(id))) return null
  return { id, rest, prefixed: prefix !== undefined }
}

/**
 * The 307 redirect of a page path to its group's URL, or null if the path stays:
 * - /groups/<id>/… of a group with a slug moves to /<slug>/…, as in the current app.
 * - /groups/<id> of a group without a slug moves to /groups/<id>/expenses, as the current app's group page does.
 * - /<id>/…, the URL of v2 before the current app's URLs came back, moves to the group's URL.
 * As in the current app, this checks no membership: the page does. Private
 * contexts are not named groups, so their pages are left to the client.
 */
export async function groupRedirect(db: Db, data: { path: IdPath; search: string }): Promise<Response | null> {
  const { id, rest, prefixed } = data.path
  const result = await db.execute<{ slug: string | null }>(sql`SELECT slug FROM groups WHERE id = ${id} AND kind = 'named'`)
  const group = result.rows[0]
  if (!group) return null
  const moved = (target: string) => new Response(null, { status: 307, headers: { Location: `${target}${data.search}`, 'Cache-Control': 'private, no-store' } })
  const path = groupPath({ id, slug: group.slug })
  if (prefixed && group.slug) return moved(`${path}${rest}`)
  if (prefixed && rest === '') return moved(`${path}/expenses`)
  if (!prefixed) return moved(`${path}${rest}`)
  return null
}
