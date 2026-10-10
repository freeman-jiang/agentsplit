import * as z from 'zod'

// Root routes and infrastructure names cannot be claimed by a group.
export const RESERVED_GROUP_SLUGS = new Set([
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

export const groupSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(63)
  .refine(
    (value) =>
      value === '' || /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(value),
    'Use 3–63 lowercase letters, numbers or hyphens; start and end with a letter or number.',
  )
  .refine((value) => !RESERVED_GROUP_SLUGS.has(value), 'This URL is reserved.')
  .nullable()
  .optional()
  .describe(
    'Optional unique group URL slug, e.g. macademia. Set null or empty string to remove it.',
  )

export function groupPath(group: { id: string; slug?: string | null }) {
  return group.slug ? `/${group.slug}` : `/groups/${group.id}`
}
