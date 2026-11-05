// The platform: a long-running Bun HTTP server around the app in app.ts, with
// a PostgreSQL pool, the receipts bucket on Garage's S3 API, the client build,
// and the hourly job. Coolify runs it in a container (v2/Dockerfile).
//   bun dist/server/server.js   (after bun run build)
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { createApp } from './app'
import { assetHandler, loadAssets } from './assets'
import { startHourly } from './hourly'
import { s3Bucket } from './s3'

/** A required setting. A missing one stops the server at start, with its name. */
function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Set ${name}`)
  return value
}
const optional = (name: string) => process.env[name]?.trim() || undefined

const config = {
  baseUrl: required('BASE_URL'),
  secret: required('BETTER_AUTH_SECRET'),
  googleClientId: required('GOOGLE_CLIENT_ID'),
  googleClientSecret: required('GOOGLE_CLIENT_SECRET'),
  bootstrapEmail: optional('AUTH_BOOTSTRAP_EMAIL'),
  documentsEnabled: /^(true|yes|1|on)$/i.test(optional('ENABLE_EXPENSE_DOCUMENTS') ?? ''),
}
const publicOrigin = new URL(config.baseUrl).origin

// One pool for the process. Each request takes one connection and returns it
// when its response is complete, as the Worker did with one connection per request.
const pool = new pg.Pool({
  connectionString: required('DATABASE_URL'),
  max: Number(optional('DATABASE_POOL_SIZE') ?? 10),
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 60_000,
})
// An idle connection that fails (a database restart) is removed from the pool; without a listener it would end the process.
pool.on('error', (error) => console.error('Idle database connection failed', error))

// The image sets MIGRATIONS_DIR, so each start applies new migrations before
// it takes requests, as the current app's container runs prisma migrate deploy.
const migrations = optional('MIGRATIONS_DIR')
if (migrations) {
  await migrate(drizzle({ client: pool }), { migrationsFolder: migrations })
  console.log('Migrations applied')
}

const bucket = s3Bucket({
  endpoint: required('S3_UPLOAD_ENDPOINT'),
  region: optional('S3_UPLOAD_REGION') ?? 'garage',
  bucket: optional('S3_UPLOAD_BUCKET') ?? 'agentsplit-receipts',
  accessKeyId: required('S3_UPLOAD_KEY'),
  secretAccessKey: required('S3_UPLOAD_SECRET'),
})

const clientDir = optional('CLIENT_DIR') ?? 'dist/client'
const assets = loadAssets(clientDir)
// The dev server has no client build: Vite serves the client and sends only API paths here.
const staticFiles = assets ? assetHandler(assets) : async () => new Response('No client build', { status: 404 })

const app = createApp({ config, connect: () => pool.connect(), bucket, assets: staticFiles })

/**
 * The request as the app must see it: at the public origin. The proxy ends
 * TLS, so Bun sees http and the internal host; OAuth checks (DPoP's htu)
 * need the URL the client used, as on Workers.
 */
function atPublicOrigin(request: Request): Request {
  const url = new URL(request.url)
  if (url.origin === publicOrigin) return request
  return new Request(`${publicOrigin}${url.pathname}${url.search}`, request)
}

const server = Bun.serve({
  hostname: optional('HOST') ?? '0.0.0.0',
  port: Number(optional('PORT') ?? 3000),
  // The largest body is a 5 MiB receipt in its multipart envelope.
  maxRequestBodySize: 8 * 1024 * 1024,
  idleTimeout: 60,
  fetch: (request) => app.fetch(atPublicOrigin(request)),
  error(error) {
    console.error('Request failed', error)
    return Response.json({ error: 'Internal server error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  },
})
console.log(`AgentSplit listening on ${server.url.href} for ${publicOrigin}`)

// The hourly job, at minute 7 of each hour (the Worker's cron was "7 * * * *").
const hourly = startHourly({ minute: 7, run: (time) => app.scheduled(time) })

// Docker sends SIGTERM, then SIGKILL after the stop grace period
// (compose.v2.coolify.yaml gives 30 seconds). Stop taking requests, let the
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
