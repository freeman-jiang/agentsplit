// The test databases. The global setup (global-setup.ts) migrates the database
// of TEST_DATABASE_URL once, and that database is the template: each test file
// works on its own copy, so the files run in parallel. Only a loopback database
// whose name contains "test" is ever dropped, and never a database the lead uses.
import pg from 'pg'
import { runMigrations } from '../../db/migrate'
import LOCAL_DATABASES from '../../db/local-databases.json'
import { makeDb, serializable, type Db } from '../../src/server/core/db'

/**
 * Why a local database must not be dropped or seeded, or null when it may be:
 * its name must be disposable, as db-reset (flake.nix) requires, and must not
 * be one that the lead uses (docs/v2/BUILDING.md).
 */
export function unsafeDatabase(name: string): string | null {
  if (LOCAL_DATABASES.protected.includes(name)) return `${name} is a database the lead uses`
  if (!LOCAL_DATABASES.disposable.some((part) => name.includes(part))) return `${name} is not a disposable database (its name has none of ${LOCAL_DATABASES.disposable.join(', ')})`
  return null
}

type Env = Readonly<Record<string, string | undefined>>

/** TEST_DATABASE_URL, or agentsplit_test on the dev shell's PostgreSQL (PGHOST, PGPORT, PGUSER). */
export function templateUrl(env: Env = process.env): URL {
  const url = new URL(env['TEST_DATABASE_URL'] ?? `postgresql://${env['PGUSER'] ?? 'postgres'}@${env['PGHOST'] ?? '127.0.0.1'}:${env['PGPORT'] ?? '5437'}/agentsplit_test`)
  const name = url.pathname.slice(1)
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !name.includes('test'))
    throw new Error(`Refusing to use ${url.hostname}/${name}: tests need a loopback database named *test*`)
  const unsafe = unsafeDatabase(name)
  if (unsafe) throw new Error(`Refusing to use ${name}: ${unsafe}`)
  // PostgreSQL names have at most 63 bytes, and a copy adds 10.
  if (name.length > 53) throw new Error(`Use a test database name of at most 53 characters, not ${name}`)
  return url
}

const nameOf = (url: URL) => url.pathname.slice(1)
/** A copy is the template's name, two underscores and 8 hex digits, so no other database matches. */
const copyName = (template: string) => `${template}__${crypto.randomUUID().slice(0, 8)}`
const isCopyOf = (template: string, name: string) => name.startsWith(`${template}__`) && /^[0-9a-f]{8}$/.test(name.slice(template.length + 2))

async function asAdmin(work: (admin: pg.Client) => Promise<void>): Promise<void> {
  const admin = new pg.Client({ connectionString: new URL('/postgres', templateUrl()).href })
  await admin.connect()
  try {
    await work(admin)
  } finally {
    await admin.end()
  }
}

/** Drops the copies that the files of this run (or of a run that crashed) left. */
export async function dropCopies(): Promise<void> {
  const template = nameOf(templateUrl())
  await asAdmin(async (admin) => {
    const all = await admin.query<{ datname: string }>('SELECT datname FROM pg_database')
    for (const { datname } of all.rows) if (isCopyOf(template, datname)) await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`)
  })
}

/** Recreates the template database with every migration applied. */
export async function migrateTemplate(): Promise<void> {
  const url = templateUrl()
  await dropCopies()
  await asAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${nameOf(url)}" WITH (FORCE)`)
    await admin.query(`CREATE DATABASE "${nameOf(url)}"`)
  })
  const pool = new pg.Pool({ connectionString: url.href, max: 1 })
  try {
    await runMigrations({ pool })
  } finally {
    await pool.end()
  }
}

export type TestDatabase = {
  readonly pool: pg.Pool
  /** Runs `work` on one pooled connection, as the server does for each request. */
  readonly withDb: <A>(work: (db: Db) => Promise<A>) => Promise<A>
  /** Runs `work` in one SERIALIZABLE transaction with the server's retries (core/db.ts). */
  readonly tx: <A>(work: (tx: Db) => Promise<A>) => Promise<A>
  readonly close: () => Promise<void>
}

/**
 * A new copy of the template, for one test file. No connection is open yet,
 * so a pool hook such as instrumentPool sees every connection.
 */
export async function testDatabase(): Promise<TestDatabase> {
  const url = templateUrl()
  const copy = copyName(nameOf(url))
  await asAdmin(async (admin) => void (await admin.query(`CREATE DATABASE "${copy}" TEMPLATE "${nameOf(url)}"`)))
  const pool = new pg.Pool({ connectionString: new URL(`/${copy}`, url).href, max: 4 })
  const withDb = async <A>(work: (db: Db) => Promise<A>): Promise<A> => {
    const client = await pool.connect()
    try {
      return await work(makeDb(client))
    } finally {
      client.release()
    }
  }
  return {
    pool,
    withDb,
    tx: (work) => withDb((db) => serializable(db, work)),
    close: async () => {
      await pool.end()
      // pg-pool's end() resolves once it has asked each connection to close, before the server has seen it.
      // FORCE would terminate such a backend, and its 57P01 reaches the pool as an unhandled error.
      // Without FORCE, PostgreSQL waits up to 5 seconds for the backends to exit, and fails if one stays.
      await asAdmin(async (admin) => void (await admin.query(`DROP DATABASE IF EXISTS "${copy}"`)))
    },
  }
}
