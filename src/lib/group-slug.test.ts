import { expenseTitle } from './expense-title'
import { groupPath, groupSlugSchema } from './group-slug'

it('normalizes optional slugs and generates canonical paths', () => {
  expect(groupSlugSchema.parse(' Macademia ')).toBe('macademia')
  expect(groupSlugSchema.parse(null)).toBeNull()
  expect(groupSlugSchema.parse(undefined)).toBeUndefined()
  expect(groupPath({ id: 'stable', slug: 'macademia' })).toBe('/macademia')
  expect(groupPath({ id: 'stable' })).toBe('/groups/stable')
})

it.each([
  'api',
  'groups',
  'sign-in',
  'invite',
  'settings',
  '../house',
  'a/b',
  '-house',
  'house-',
  'a',
  'a'.repeat(64),
])('rejects invalid or reserved slug %s', (slug) => {
  expect(groupSlugSchema.safeParse(slug).success).toBe(false)
})

it('formats optional vendors without changing the stored title', () => {
  expect(expenseTitle({ title: 'Hangers', vendor: 'Costco' })).toBe(
    'Costco — Hangers',
  )
  expect(expenseTitle({ title: 'Rent', vendor: null })).toBe('Rent')
  expect(expenseTitle({ title: 'Legacy — title' })).toBe('Legacy — title')
})
