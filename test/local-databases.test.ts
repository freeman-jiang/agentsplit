// The lead's local databases (docs/v2/BUILDING.md) must survive every command
// that drops or seeds one: a guard that lets one through destroys it without
// a sign. db-reset runs against a PostgreSQL address that does not exist, so a
// broken guard fails to connect instead of dropping anything.
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import LOCAL_DATABASES from '../db/local-databases.json'
import { templateUrl, unsafeDatabase } from './kit/database'

describe.each(LOCAL_DATABASES.protected)('%s', (name) => {
  it('is refused by the test kit and the seed script', () => {
    expect(unsafeDatabase(name)).toBe(`${name} is a database the lead uses`)
    expect(() => templateUrl({ TEST_DATABASE_URL: `postgresql://postgres@127.0.0.1:5437/${name}` })).toThrow(/^Refusing to use/)
  })

  it('is refused by db-reset', () => {
    const reset = spawnSync('db-reset', [name], { encoding: 'utf8', env: { ...process.env, PGHOST: '/nonexistent', PGPORT: '1' } })
    expect({ status: reset.status, stderr: reset.stderr }).toEqual({ status: 1, stderr: `db-reset: refusing to reset '${name}': the lead uses it (docs/v2/BUILDING.md)\n` })
  })
})
