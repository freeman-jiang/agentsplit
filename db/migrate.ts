// The one migration runner: the server applies the migrations at start
// (MIGRATIONS_DIR in the image), the tests apply them to their template
// database, and this file applies them to DATABASE_URL when run directly:
//   DATABASE_URL=... bun db/migrate.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

/** The SQL migrations beside this file. The image copies them to dist/migrations. */
export const MIGRATIONS_DIR = new URL('./migrations', import.meta.url).pathname

/** Applies every migration in `dir` that `pool` has not applied yet, in one transaction. */
export async function runMigrations(data: { pool: pg.Pool; dir?: string }): Promise<void> {
  await migrate(drizzle({ client: data.pool }), { migrationsFolder: data.dir ?? MIGRATIONS_DIR })
}

if (import.meta.main) {
  const url = process.env['DATABASE_URL']
  if (!url) throw new Error('Set DATABASE_URL')
  const pool = new pg.Pool({ connectionString: url, max: 1 })
  await runMigrations({ pool })
  await pool.end()
  console.log('Migrations applied')
}
