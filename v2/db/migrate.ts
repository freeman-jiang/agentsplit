// Applies db/migrations to DATABASE_URL. Usage: DATABASE_URL=... bun db/migrate.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

const url = process.env['DATABASE_URL']
if (!url) throw new Error('Set DATABASE_URL')
const pool = new Pool({ connectionString: url, max: 1 })
await migrate(drizzle({ client: pool }), { migrationsFolder: new URL('./migrations', import.meta.url).pathname })
await pool.end()
console.log('Migrations applied')
