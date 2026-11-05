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

/** The problem with a normalized, non-empty slug, or null if it is valid. */
export function slugProblem(slug: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(slug))
    return 'Use 3–63 lowercase letters, numbers or hyphens; start and end with a letter or number.'
  if (RESERVED_GROUP_SLUGS.has(slug)) return 'This URL is reserved.'
  return null
}

/** The group's canonical URL segment: its slug, else its ID. */
export const groupRef = (group: { id: string; slug: string | null }) => group.slug ?? group.id

export const INVITATION_DAYS = 7
/** An invitation token: 32 random bytes in base64url (P-ACCESS-14). */
export const INVITATION_TOKEN = /^[A-Za-z0-9_-]{43}$/
