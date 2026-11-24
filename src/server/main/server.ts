// The platform: a long-running Bun HTTP server around the app in app.ts, with
// a PostgreSQL pool, the receipts bucket on an S3 API, the client build, and
// the hourly job. The NixOS host runs it as agentsplit.service (nix/module.nix).
//   bun dist/server/server.js   (after bun run build)
import pg from 'pg'
import { runMigrations } from '../../../db/migrate'
import { createApp } from './app'
import { clientFiles } from '../assets'
import { readSettings } from '../core/config'
import { jsonError } from '../core/errors'
import { makeDb } from '../core/db'
import { startHourly } from '../hourly'
import { instrumentPool } from '../perf'
import { s3Bucket } from '../s3'

const settings = readSettings(process.env)
const { app: config } = settings
const publicOrigin = new URL(config.baseUrl).origin
// Read before the migrations, so a missing client build stops the start before it changes the database.
const staticFiles = clientFiles({ dir: settings.clientDir, baseUrl: config.baseUrl })

// The image sets MIGRATIONS_DIR, so each start applies new migrations before
// it takes requests, as the current app's container runs prisma migrate deploy.
// Migrations run on their own short-lived pool without query_timeout.
if (settings.migrationsDir) {
  const migrationPool = new pg.Pool({ connectionString: settings.databaseUrl, max: 1, connectionTimeoutMillis: 5_000 })
  try {
    await runMigrations({ pool: migrationPool, dir: settings.migrationsDir })
  } finally {
    await migrationPool.end()
  }
  console.log('Migrations applied')
}

// One pool for the process. RPC, MCP, receipt and export requests each take
// one connection for their database work and return it before any slow body or
// storage I/O. Better Auth takes connections from the pool for each of its own queries.
const pool = new pg.Pool({
  connectionString: settings.databaseUrl,
  max: settings.poolSize,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 60_000,
  // Server-side limits free stuck SQL, locks, and abandoned transactions.
  // query_timeout is the client-side backstop if PostgreSQL itself freezes or the socket stalls.
  lock_timeout: 10_000,
  statement_timeout: 30_000,
  idle_in_transaction_session_timeout: 60_000,
  query_timeout: 35_000,
})
// An idle connection that fails (a database restart) is removed from the pool; without a listener it would end the process.
pool.on('error', (error) => console.error('Idle database connection failed', error))
if (config.perfInstrumentation) instrumentPool(pool)

const bucket = s3Bucket(settings.s3)

const app = createApp({ config, connect: () => pool.connect(), pool: makeDb(pool), bucket, assets: staticFiles })

/**
 * The request as the app must see it: at the public origin. The proxy ends
 * TLS, so Bun sees http and the internal host; OAuth checks (DPoP's htu)
 * need the URL the client used.
 */
function atPublicOrigin(request: Request): Request {
  const url = new URL(request.url)
  if (url.origin === publicOrigin) return request
  return new Request(`${publicOrigin}${url.pathname}${url.search}`, request)
}

const server = Bun.serve({
  hostname: settings.host,
  port: settings.port,
  // The largest body is a receipt (LIMITS.receiptBytes) in its multipart envelope.
  maxRequestBodySize: 8 * 1024 * 1024,
  idleTimeout: 60,
  fetch: (request) => app.fetch(atPublicOrigin(request)),
  error(error) {
    console.error('Request failed', error)
    return jsonError({ status: 500, message: 'Internal server error' })
  },
})
console.log(`AgentSplit listening on ${server.url.href} for ${publicOrigin}${config.maintenance ? ' (maintenance: answering 503)' : ''}`)

const hourly = startHourly({ minute: 7, run: (time) => app.scheduled(time) })

// systemd sends SIGTERM, then SIGKILL after TimeoutStopSec (nix/module.nix
// gives 30 seconds). Stop taking requests, let the
// running ones and the job finish, then close the pool.
const SHUTDOWN_MS = 25_000
let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`${signal}: stopping`)
  const force = setTimeout(() => {
    console.error('Shutdown took too long; exiting with requests still open')
    process.exit(1)
  }, SHUTDOWN_MS)
  try {
    await Promise.all([server.stop(), hourly.stop()])
    await pool.end()
  } catch (error) {
    console.error('Shutdown failed', error)
    process.exit(1)
  }
  clearTimeout(force)
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
