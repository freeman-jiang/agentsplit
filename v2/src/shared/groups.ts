// Pure group rules shared by the client and the server. No Effect import here:
// the client bundle must stay free of the Effect runtime (BUILDING.md).

/** Root routes and infrastructure names a group cannot claim (P-GROUP-94). */
export const RESERVED_GROUP_SLUGS: ReadonlySet<string> = new Set([
  'sign-in',
  'api',
  'groups',
  'expenses',
  'agents',
  'login',
  'logout',
  'signup',
  'auth',
  'invite',
  'join',
  'settings',
  'account',
  'admin',
  'health',
  'about',
  'privacy',
  'terms',
  'robots',
  'sitemap',
  'favicon',
  'manifest',
  'opengraph-image',
  'twitter-image',
])

/** A slug is trimmed and lowercased before it is checked and stored (P-GROUP-92). */
export const normalizeSlug = (slug: string) => slug.trim().toLowerCase()

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/

/** The problem with a normalized, non-empty slug, or null if it is valid. */
export function slugProblem(slug: string): string | null {
  if (!SLUG_PATTERN.test(slug)) return 'Use 3–63 lowercase letters, numbers or hyphens; start and end with a letter or number.'
  if (RESERVED_GROUP_SLUGS.has(slug)) return 'This URL is reserved.'
  return null
}

/** The group's segment in the client's routes: its slug, else its ID. */
export const groupRef = (group: { id: string; slug: string | null }) => group.slug ?? group.id

/**
 * The group's URL path, as in the current app (src/lib/group-slug.ts):
 * `/<slug>`, or `/groups/<id>` for a group without a slug (P-GROUP-98).
 */
export const groupPath = (group: { id: string; slug: string | null }) => (group.slug ? `/${group.slug}` : `/groups/${encodeURIComponent(group.id)}`)

/**
 * Whether a route segment is a group ID that no slug can be. Only the segment
 * is known here, so an ID that also has the form of a slug (lowercase letters,
 * numbers and hyphens only) counts as a slug: its pages stay at `/<id>/…`,
 * which also works.
 */
export const isIdSegment = (segment: string) => segment !== '' && !SLUG_PATTERN.test(segment)

/** The URL path of the group that a route segment names. */
export const segmentPath = (segment: string) => (isIdSegment(segment) ? `/groups/${encodeURIComponent(segment)}` : `/${encodeURIComponent(segment)}`)

/** A 21-character group ID, the format of the current app's nanoid() IDs and of randomId(). */
export const GROUP_ID = /^[A-Za-z0-9_-]{21}$/

export const INVITATION_DAYS = 7
/** An invitation token: 32 random bytes in base64url (P-ACCESS-14). */
export const INVITATION_TOKEN = /^[A-Za-z0-9_-]{43}$/
