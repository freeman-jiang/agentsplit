// A group slug is the first segment of the group's URL, so a slug that names
// a root page would take that page's URL without any error (P-GROUP-94).
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { slugProblem } from '~/shared/groups'

it('reserves the first segment of every root route of the client', () => {
  const routes = readdirSync(join(import.meta.dirname, '..', 'src', 'client', 'routes'))
  // The router ignores files that start with "-"; "$group" is the group itself, and "__root" and "index" have no segment.
  const segments = new Set(routes.filter((name) => !/^[-$_]|^index\./.test(name)).map((name) => name.replace(/\.tsx$/, '').split('.')[0] ?? ''))
  expect(segments.size).toBeGreaterThan(0)
  for (const segment of segments) expect(slugProblem(segment), segment).toBe('This URL is reserved.')
})

it('reserves the client build’s chunk folder, which the server answers itself', () => {
  expect(slugProblem('assets')).toBe('This URL is reserved.')
})
