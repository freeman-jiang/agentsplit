// Applies db/migrations to DATABASE_URL. Usage: DATABASE_URL=... [DB_ROLE=...] bun db/migrate.ts
// On apps-pg, connect through cloud-sql-proxy as the admin IAM user and set
// DB_ROLE=<app>_owner, so every object belongs to the app's owner role.
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

const url = process.env['DATABASE_URL']
if (!url) throw new Error('Set DATABASE_URL')
const pool = new Pool({ connectionString: url, max: 1 })
const role = process.env['DB_ROLE']
if (role) {
  if (!/^[a-z0-9_]+_owner$/.test(role)) throw new Error(`Unexpected DB_ROLE ${role}`)
  pool.on('connect', (client) => void client.query(`SET ROLE "${role}"`))
}
await migrate(drizzle({ client: pool }), { migrationsFolder: new URL('./migrations', import.meta.url).pathname })
await pool.end()
console.log('Migrations applied')
