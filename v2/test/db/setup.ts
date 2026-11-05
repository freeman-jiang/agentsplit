import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

/** Drops and recreates the disposable test database, applies every migration, and returns a pool. */
export async function resetTestDatabase(): Promise<Pool> {
  const url = new URL(process.env['TEST_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:5437/agentsplit_test')
  const name = url.pathname.slice(1)
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/test/.test(name))
    throw new Error(`Refusing to reset ${url.hostname}/${name}: tests need a loopback database named *test*`)
  const admin = new Pool({ connectionString: new URL('/postgres', url).href, max: 1 })
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.query(`CREATE DATABASE "${name}"`)
  await admin.end()
  const pool = new Pool({ connectionString: url.href, max: 4 })
  await migrate(drizzle({ client: pool }), { migrationsFolder: new URL('../../db/migrations', import.meta.url).pathname })
  return pool
}
