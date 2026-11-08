// The capacity benchmark: how many monthly active people one small VM can
// host. It runs the production build against a private PostgreSQL 18 with the
// production host's settings, replays a month of a synthetic person's use for
// many people (real browser opens and an agent's MCP traffic), measures the
// CPU time, bytes, disk and memory that it costs, and turns them into a
// capacity under each limit of the target VM. docs/CAPACITY.md has the method
// and the latest results.
//
// Run it inside the dev shell (it needs initdb, db-reset, nix and Chromium):
//   direnv exec . bun scripts/capacity.ts [--users 60] [--target-score <score>]
// --calibrate prints this machine's CPU score and exits; it touches no network
// and no database. Run the same calibration on the target and pass its score
// as --target-score (or the ratio of the two scores as --cpu-scale):
//   bun scripts/capacity/calibrate.ts
// Flags (the e2-micro of DEPLOYMENT.md by default; `--help` lists them all):
//   --users N             people (default 60; more people spread the rate limits thinner)
//   --concurrency N       parallel clients (default 6)
//   --opens, --web-expenses, --agent-sessions, --agent-reads, --agent-expenses
//                         the month of one person (default 30, 5, 10, 30, 10)
//   --cores, --page-cache-mb, --disk-gb, --read-iops, --write-iops, --free-egress-gb,
//   --egress-price, --peak-factor, --packet-overhead, --backup-pulls, --dumps-kept,
//   --dumps-per-month     the target and the assumptions of the report
//   --skip-build          reuse dist/ from an earlier `bun run build`
// It creates the database agentsplit_capacity in its own PostgreSQL instance in a
// temporary directory, and removes the instance, the server and the directory
// at the end, also when it fails.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, openSync, rmSync, statSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'
import pg from 'pg'
import { runMigrations } from '../db/migrate'
import { makeDb } from '../src/server/core/db'
import { LIMITS } from '../src/shared/limits'
import { testSettings } from '../test/kit/config'
import { calibrate, calibrationText } from './capacity/calibrate'
import { startEdge, type Edge, type Exchange } from './capacity/edge'
import { hostConfig, run, startInstance, type Instance } from './capacity/host'
import { instanceCpuSeconds, instancePssBytes, peakRssBytes, processCpuSeconds } from './capacity/processes'
import { credentials, generator, seedPeople, type Credentials, type SyntheticUser } from './capacity/seed'
import { agentConnect, agentRead, agentWrite, appOpen, appOpenWithExpense, contexts, READ_TOOLS, type Clients } from './capacity/workload'

const DATABASE = 'agentsplit_capacity'
/** The tables that every balance reads in full for its group. */
const HOT_TABLES = ['public.expenses', 'public.expense_payers', 'public.expense_shares'] as const
const SECONDS_PER_MONTH = 30 * 86_400
const MB = 1024 * 1024
const GB = 1024 * MB

const number = (fallback: number) => ({ type: 'string' as const, default: String(fallback) })
const FLAGS = {
  users: number(60),
  concurrency: number(6),
  seed: number(42),
  opens: number(30),
  'web-expenses': number(5),
  'agent-sessions': number(10),
  'agent-reads': number(30),
  'agent-expenses': number(10),
  'cpu-scale': number(0),
  'target-score': number(0),
  cores: number(0.25),
  'memory-mb': number(1024),
  'page-cache-mb': number(400),
  'disk-gb': number(20),
  'read-iops': number(22),
  'write-iops': number(45),
  'free-egress-gb': number(1),
  'egress-price': number(0.12),
  'peak-factor': number(3),
  'packet-overhead': number(64),
  'backup-pulls': number(30),
  'dumps-kept': number(72),
  'dumps-per-month': number(720),
  'idle-seconds': number(20),
} as const

const parsed = parseArgs({
  options: {
    ...FLAGS,
    calibrate: { type: 'boolean', default: false },
    'skip-build': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  strict: true,
})

if (parsed.values.help) {
  console.log(['bun scripts/capacity.ts [--calibrate] [--skip-build]', ...Object.entries(FLAGS).map(([name, f]) => `  --${name} <number>  (default ${f.default})`)].join('\n'))
  process.exit(0)
}

if (parsed.values.calibrate) {
  console.log(calibrationText(calibrate()))
  process.exit(0)
}

/** A numeric flag; anything but a finite number of at least 0 stops the run. */
function flag(name: keyof typeof FLAGS): number {
  const value = parsed.values[name]
  const result = Number(value)
  if (typeof value !== 'string' || !Number.isFinite(result) || result < 0) throw new Error(`--${name} takes a number of at least 0, not ${String(value)}`)
  return result
}

const profile = {
  opens: flag('opens'),
  webExpenses: flag('web-expenses'),
  agentSessions: flag('agent-sessions'),
  agentReads: flag('agent-reads'),
  agentExpenses: flag('agent-expenses'),
}
if (profile.webExpenses > profile.opens) throw new Error('--web-expenses counts app opens, so it must not exceed --opens')
const userCount = flag('users')
const concurrency = Math.max(1, Math.floor(flag('concurrency')))
if (userCount < 2) throw new Error('Use --users 2 or more')

// ---------- helpers ----------

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = net.createServer()
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? done(address.port) : fail(new Error('No port'))))
    })
  })
}

/** Runs `work` for each item with at most `limit` at a time, in order of start. The first failure stops the rest. */
async function inParallel<A>(items: readonly A[], limit: number, work: (item: A, index: number) => Promise<void>) {
  let next = 0
  let failure: Error | null = null
  const worker = async () => {
    while (failure === null && next < items.length) {
      const index = next++
      const item = items[index]
      if (item === undefined) continue
      try {
        await work(item, index)
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error))
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  if (failure) throw failure
}

/**
 * Each person's `count` units, in turns: everyone's first unit, then everyone's
 * second. That spreads each person's requests over the phase. Within a turn
 * the groups alternate (the first person of each group, then the second of
 * each), so the parallel clients rarely write to the same group at once. The
 * people of a group seldom write in the same few milliseconds, and parallel
 * writes to one group conflict under SERIALIZABLE (docs/CAPACITY.md).
 */
function turns(users: readonly SyntheticUser[], count: (u: SyntheticUser) => number): { user: SyntheticUser; turn: number }[] {
  const rank = (u: SyntheticUser) => u.home.members.indexOf(u.userId)
  const ordered = users.map((user, index) => ({ user, index })).sort((a, b) => rank(a.user) - rank(b.user) || a.index - b.index)
  const most = Math.max(0, ...users.map(count))
  const items: { user: SyntheticUser; turn: number }[] = []
  for (let turn = 0; turn < most; turn++) for (const { user } of ordered) if (turn < count(user)) items.push({ user, turn })
  return items
}

const fixed = (value: number, digits = 1) => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const whole = (value: number) => (Number.isFinite(value) ? Math.floor(value).toLocaleString('en-US') : 'unlimited')
const kb = (bytes: number) => `${fixed(bytes / 1024)} KB`
const mb = (bytes: number) => `${fixed(bytes / MB)} MB`

/** A text table with a header row; numbers right-aligned. */
function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: readonly string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join('  ')
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n')
}

// ---------- measurements ----------

type Counters = { readonly server: number; readonly postgres: number; readonly at: number; readonly exchanges: number }

type Stats = {
  readonly commits: number
  readonly blocks: number
  readonly blockReads: number
  readonly walFsyncs: number
  readonly walWrites: number
  readonly dataWrites: number
  readonly walBytes: number
}

type Sizes = { readonly database: number; readonly tables: number; readonly byTable: ReadonlyMap<string, number> }

async function stats(client: pg.Pool): Promise<Stats> {
  const result = await client.query<{ [K in keyof Stats]: string }>(`
    SELECT
      (SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()) AS "commits",
      (SELECT blks_hit + blks_read FROM pg_stat_database WHERE datname = current_database()) AS "blocks",
      (SELECT blks_read FROM pg_stat_database WHERE datname = current_database()) AS "blockReads",
      (SELECT coalesce(sum(fsyncs), 0) FROM pg_stat_io WHERE object = 'wal') AS "walFsyncs",
      (SELECT coalesce(sum(writes), 0) FROM pg_stat_io WHERE object = 'wal') AS "walWrites",
      (SELECT coalesce(sum(writes), 0) FROM pg_stat_io WHERE object = 'relation') AS "dataWrites",
      (SELECT wal_bytes FROM pg_stat_wal) AS "walBytes"`)
  const row = result.rows[0]
  if (!row) throw new Error('No statistics row')
  return {
    commits: Number(row.commits),
    blocks: Number(row.blocks),
    blockReads: Number(row.blockReads),
    walFsyncs: Number(row.walFsyncs),
    walWrites: Number(row.walWrites),
    dataWrites: Number(row.dataWrites),
    walBytes: Number(row.walBytes),
  }
}

/** The statistics after this backend's own pending counts are flushed (at the end of the next transaction). */
async function flushedStats(client: pg.Pool): Promise<Stats> {
  await client.query('SELECT pg_stat_force_next_flush()')
  await client.query('SELECT 1')
  return stats(client)
}

async function sizes(client: pg.Pool): Promise<Sizes> {
  const tables = await client.query<{ name: string; bytes: string }>(`SELECT schemaname || '.' || relname AS name, pg_total_relation_size(relid) AS bytes FROM pg_stat_user_tables`)
  const database = await client.query<{ bytes: string }>(`SELECT pg_database_size(current_database()) AS bytes`)
  const byTable = new Map(tables.rows.map((r) => [r.name, Number(r.bytes)]))
  return { database: Number(database.rows[0]?.bytes ?? 0), tables: [...byTable.values()].reduce((a, b) => a + b, 0), byTable }
}

/** One dump as the host's agentsplit-db-dump makes it (pg_dump custom format, then pg_restore --list). Returns its size and CPU seconds. */
function dump(data: { instance: Instance; file: string }) {
  const before = instanceCpuSeconds(data.instance.postmaster)
  let tools = 0
  for (const cmd of [
    ['pg_dump', '--format=custom', `--dbname=${DATABASE}`, `--file=${data.file}`],
    ['pg_restore', '--list', data.file],
  ]) {
    const done = Bun.spawnSync(cmd, { env: data.instance.env, stdout: 'ignore', stderr: 'pipe' })
    if (done.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed: ${done.stderr.toString()}`)
    const usage = done.resourceUsage
    tools += (Number(usage.cpuTime.user) + Number(usage.cpuTime.system)) / 1e6
  }
  const bytes = statSync(data.file).size
  rmSync(data.file)
  return { bytes, cpuSeconds: tools + instanceCpuSeconds(data.instance.postmaster) - before }
}

/** The mean of five dumps, so the 10 ms ticks of /proc average out. */
function dumps(data: { instance: Instance; file: string }) {
  const runs = [dump(data), dump(data), dump(data), dump(data), dump(data)]
  return { bytes: runs[0]?.bytes ?? 0, cpuSeconds: runs.reduce((sum, r) => sum + r.cpuSeconds, 0) / runs.length }
}

// ---------- the run ----------

const cleanups: (() => Promise<void> | void)[] = []
async function cleanUp() {
  for (const step of cleanups.reverse()) {
    try {
      await step()
    } catch (error) {
      console.error('Cleanup step failed', error)
    }
  }
  cleanups.length = 0
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    console.error(`${signal}: stopping`)
    void cleanUp().then(() => process.exit(1))
  })

const log = (text: string) => console.error(`[capacity] ${text}`)
/** The server's output, which the cleanup removes with the temporary directory: a failed run prints its end first. */
let serverLog: string | null = null

try {
  if (process.platform !== 'linux') throw new Error('The benchmark reads /proc: run it on Linux')
  for (const tool of ['initdb', 'pg_ctl', 'pg_dump', 'db-reset', 'nix'])
    if (!Bun.which(tool)) throw new Error(`${tool} is not on PATH: run the benchmark in the dev shell (direnv exec . bun scripts/capacity.ts)`)
  const chromiumPath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']
  if (!chromiumPath) throw new Error('Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH (the dev shell sets it)')

  // The CPU scale: from the target's score and a calibration here, or as given.
  log('Calibrating this machine')
  const local = calibrate()
  const targetScore = flag('target-score')
  const cpuScale = flag('cpu-scale') || (targetScore ? local.score / targetScore : 1)

  log('Reading the production host settings from the flake')
  const host = hostConfig()
  if (!parsed.values['skip-build']) {
    log('Building (bun run build)')
    run({ cmd: ['bun', 'run', 'build'] })
  }

  const work = mkdtempSync(join(tmpdir(), 'agentsplit-capacity-'))
  cleanups.push(() => rmSync(work, { recursive: true, force: true }))
  const [pgPort, serverPort, edgePort] = [await freePort(), await freePort(), await freePort()]
  if (!pgPort || !serverPort || !edgePort) throw new Error('No free port')

  log(`Starting PostgreSQL ${host.postgresqlVersion} settings in ${work}`)
  const instance = startInstance({ dir: work, port: pgPort, config: host })
  cleanups.push(() => instance.stop())
  run({ cmd: ['db-reset', DATABASE], env: instance.env })
  const admin = new pg.Pool({ connectionString: instance.url(DATABASE), max: 1 })
  cleanups.push(() => admin.end())
  await runMigrations({ pool: admin })
  const dumpFile = join(work, 'capacity.dump')
  const emptyDump = dumps({ instance, file: dumpFile })

  const baseUrl = `http://127.0.0.1:${edgePort}`
  const secret = randomBytes(32).toString('hex')
  const settings = testSettings({ baseUrl, secret, googleClientId: 'capacity-client', googleClientSecret: 'capacity-secret' })
  const random = generator(flag('seed'))
  const today = new Date()
  log(`Seeding ${userCount} people`)
  const seeded = await seedPeople(makeDb(admin), { count: userCount, random, today })
  const seededSizes = await sizes(admin)
  const creds = await credentials(makeDb(admin), { users: seeded.users, settings })
  const credentialsOf = (userId: string): Credentials => {
    const found = creds.get(userId)
    if (!found) throw new Error(`No credentials for ${userId}`)
    return found
  }

  const edge: Edge = await startEdge({ clientDir: resolve('dist/client'), target: { host: '127.0.0.1', port: serverPort }, port: edgePort })
  cleanups.push(() => edge.close())

  log('Starting the server (bun --no-install dist/server/server.js)')
  serverLog = join(work, 'server.log')
  const out = openSync(serverLog, 'w')
  const server = Bun.spawn(['bun', '--no-install', 'dist/server/server.js'], {
    env: {
      PATH: process.env['PATH'],
      ...host.serverEnvironment,
      // nix/package.nix's launcher sets these.
      NODE_ENV: 'production',
      TZ: 'UTC',
      CLIENT_DIR: resolve('dist/client'),
      DATABASE_URL: instance.url(DATABASE),
      PORT: String(serverPort),
      BASE_URL: baseUrl,
      BETTER_AUTH_SECRET: secret,
      GOOGLE_CLIENT_ID: settings.googleClientId,
      GOOGLE_CLIENT_SECRET: settings.googleClientSecret,
      // Receipts redirect to R2 in production and never pass through the VM; the text-only month uploads none.
      RECEIPT_DOWNLOADS: 'redirect',
      S3_UPLOAD_ENDPOINT: 'http://127.0.0.1:9',
      S3_UPLOAD_KEY: 'capacity',
      S3_UPLOAD_SECRET: 'capacity',
    },
    stdout: out,
    stderr: out,
  })
  cleanups.push(async () => {
    server.kill('SIGTERM')
    await server.exited
  })
  for (let i = 0; ; i++) {
    if (server.exitCode !== null) throw new Error(`The server exited (${server.exitCode})`)
    const ready = await fetch(`http://127.0.0.1:${serverPort}/api/health`).then(
      (r) => r.ok,
      () => false,
    )
    if (ready) break
    if (i > 100) throw new Error('The server did not get ready in 20 seconds')
    await Bun.sleep(200)
  }

  const browser = await chromium.launch({ executablePath: chromiumPath })
  cleanups.push(() => browser.close())
  const clients: Clients = { edge: edge.origin, browser, credentialsOf }
  const browsers = contexts(clients)
  cleanups.push(() => browsers.closeAll())
  const day = today.toISOString().slice(0, 10)

  type Phase = {
    readonly name: string
    /** Units per person per month. */
    readonly perMonth: number
    readonly unit: (user: SyntheticUser, turn: number) => Promise<void>
  }
  const phases: readonly Phase[] = [
    { name: 'app open', perMonth: profile.opens - profile.webExpenses, unit: async (user) => appOpen({ context: await browsers.of(user), user }) },
    { name: 'app open + new expense', perMonth: profile.webExpenses, unit: async (user) => appOpenWithExpense({ context: await browsers.of(user), user, random }) },
    { name: 'agent connect', perMonth: profile.agentSessions, unit: (user) => agentConnect({ clients, user }) },
    { name: 'agent read', perMonth: profile.agentReads, unit: (user, turn) => agentRead({ clients, user, tool: READ_TOOLS[turn % READ_TOOLS.length] ?? 'list_groups' }) },
    { name: 'agent new expense', perMonth: profile.agentExpenses, unit: (user) => agentWrite({ clients, user, random, today: day }) },
  ]

  // Warm-up, not counted: the JIT and the caches, and the rows that each
  // person has once, not each month (the rate-limit buckets, the API key's
  // counters), so the month's growth is history only. It adds one expense per person.
  log('Warming up')
  edge.setPhase('warm-up')
  await inParallel(seeded.users, concurrency, async (user) => {
    await appOpen({ context: await browsers.of(user), user })
    await agentConnect({ clients, user })
    for (const tool of READ_TOOLS) await agentRead({ clients, user, tool })
    await agentWrite({ clients, user, random, today: day })
  })

  // Compact the tables, so the sizes before and after count live rows, not the dead ones of the seed.
  // ANALYZE leaves autovacuum nothing to do for the seed's rows during the idle time.
  await admin.query('VACUUM (FULL, ANALYZE)')
  await Bun.sleep(5000)

  const counters = (): Counters => ({ server: processCpuSeconds(server.pid), postgres: instanceCpuSeconds(instance.postmaster), at: performance.now(), exchanges: edge.exchanges.length })
  let peakPostgres = 0
  const sampler = setInterval(() => void (peakPostgres = Math.max(peakPostgres, instancePssBytes(instance.postmaster))), 250)
  cleanups.push(() => clearInterval(sampler))

  // The idle time also lets the server's backends flush their statistics (each idle backend does within 10 s).
  log(`Measuring ${flag('idle-seconds')} s of idle time`)
  edge.setPhase('idle')
  const idleStart = counters()
  await Bun.sleep(flag('idle-seconds') * 1000)
  const idleEnd = counters()
  const idleSeconds = (idleEnd.at - idleStart.at) / 1000
  const idleCores = { server: (idleEnd.server - idleStart.server) / idleSeconds, postgres: (idleEnd.postgres - idleStart.postgres) / idleSeconds }
  const before = { sizes: await sizes(admin), stats: await flushedStats(admin) }

  type Measured = { readonly phase: Phase; readonly units: number; readonly cpu: { server: number; postgres: number }; readonly wallSeconds: number; readonly exchanges: readonly Exchange[] }
  const measured: Measured[] = []
  for (const phase of phases) {
    const items = turns(seeded.users, () => phase.perMonth)
    if (!items.length) continue
    log(`Phase "${phase.name}": ${items.length} units`)
    edge.setPhase(phase.name)
    const start = counters()
    await inParallel(items, concurrency, ({ user, turn }) => phase.unit(user, turn))
    const end = counters()
    measured.push({
      phase,
      units: items.length,
      cpu: { server: end.server - start.server, postgres: end.postgres - start.postgres },
      wallSeconds: (end.at - start.at) / 1000,
      exchanges: edge.exchanges.slice(start.exchanges, end.exchanges),
    })
  }
  const workEnd = counters()

  // Background work that the month left behind (autovacuum, the checkpoint), above the idle rate. The statistics flush meanwhile.
  log('Waiting for the background work to finish')
  edge.setPhase('settle')
  const settleSeconds = 15
  await Bun.sleep(settleSeconds * 1000)
  const settled = counters()
  const background = Math.max(0, settled.postgres - workEnd.postgres - idleCores.postgres * settleSeconds) + Math.max(0, settled.server - workEnd.server - idleCores.server * settleSeconds)
  clearInterval(sampler)
  const peakServer = peakRssBytes(server.pid)

  // The checkpoint writes the pages that the month changed, as the host's checkpoints (every 5 minutes) do.
  await admin.query('CHECKPOINT')
  const afterStats = await flushedStats(admin)
  const rawAfter = await sizes(admin)
  await admin.query('VACUUM (FULL, ANALYZE)')
  const after = await sizes(admin)
  const fullDump = dumps({ instance, file: dumpFile })

  // ---------- the report ----------

  const U = seeded.users.length
  const monthUnits = (m: Measured) => m.phase.perMonth
  const bytesOf = (e: Exchange) => e.headerBytes + e.bodyBytes
  const packetOverhead = flag('packet-overhead')
  /** On the wire: one packet per 1,200 bytes of the answer, and one for the request's acknowledgement, each with `packetOverhead` bytes of headers. */
  const wireOf = (e: Exchange) => bytesOf(e) + (Math.ceil(bytesOf(e) / 1200) + 1) * packetOverhead

  const lines: string[] = []
  const say = (text = '') => lines.push(text)
  say(`AgentSplit capacity benchmark, ${today.toISOString().slice(0, 16)}Z, commit ${run({ cmd: ['git', 'rev-parse', '--short', 'HEAD'] }).trim()}`)
  say(`People: ${U} in ${seeded.groups.length} groups (${seeded.groups.map((g) => g.members.length).join(' ')} people); seeded expenses per group: ${seeded.history.join(' ')}`)
  say(`Seeded data: ${mb(seededSizes.tables)} in tables, ${kb(seededSizes.tables / U)} per person`)
  say(`Server: the production build on Bun ${Bun.version}, pool ${host.poolSize}; PostgreSQL ${run({ cmd: ['postgres', '--version'] }).trim().split(' ').at(-1)} with the host's settings (shared_buffers ${String(host.postgresql['shared_buffers'])}, fsync on)`)
  say(`Clients: ${concurrency} at a time; Chromium for app opens, fetch for MCP. Static files come from the edge stand-in, as from Cloudflare's cache.`)
  say()
  say(calibrationText(local).replace('Calibration score', 'This machine'))
  say(
    flag('cpu-scale')
      ? `CPU scale: ${fixed(cpuScale, 2)} (given)`
      : targetScore
        ? `CPU scale: ${fixed(cpuScale, 2)} = ${Math.round(local.score)} here / ${targetScore} on the target`
        : 'CPU scale: 1.00. No --target-score or --cpu-scale: the CPU numbers are for this machine, not the target',
  )
  say()

  say('The month of one person (assumed; flags change it):')
  say(`  ${profile.opens} app opens (dashboard, Groups, the group's expenses), ${profile.webExpenses} of them add an expense in the form`)
  say(`  ${profile.agentSessions} agent sessions (initialize, initialized, GET stream, tools/list), ${profile.agentReads} reads (${READ_TOOLS.join(', ')} in turn), ${profile.agentExpenses} create_expense`)
  say(`  ${profile.webExpenses + profile.agentExpenses} new expenses, text notes only, no receipts`)
  say()

  say('Measured cost of each unit (CPU on this machine, bytes leaving the origin with headers):')
  say(
    table(
      ['Unit', 'Units', 'Requests/unit', 'Bun ms/unit', 'PG ms/unit', 'KB/unit', 'Per month'],
      measured.map((m) => [
        m.phase.name,
        String(m.units),
        fixed(m.exchanges.length / m.units),
        fixed((m.cpu.server * 1000) / m.units),
        fixed((m.cpu.postgres * 1000) / m.units),
        fixed(m.exchanges.reduce((s, e) => s + bytesOf(e), 0) / m.units / 1024, 2),
        String(monthUnits(m)),
      ]),
    ),
  )
  say()

  const all = measured.flatMap((m) => m.exchanges)
  const failed = all.filter((e) => e.status >= 400 && !(e.label === 'mcp GET' && e.status === 405))
  if (failed.length) throw new Error(`${failed.length} requests failed: ${failed.slice(0, 5).map((e) => `${e.label} ${e.status}`).join(', ')}`)
  const labels = [...new Set(all.map((e) => e.label))].sort()
  say('Each request at the origin (Accept-Encoding: gzip; bytes include the status line and headers):')
  say(
    table(
      ['Request', 'Count', 'Status', 'Headers B', 'Body B', 'Unzipped B', 'Gzip', 'p50 ms'],
      labels.map((label) => {
        const of = all.filter((e) => e.label === label)
        const mean = (f: (e: Exchange) => number) => of.reduce((s, e) => s + f(e), 0) / of.length
        const times = of.map((e) => e.milliseconds).sort((a, b) => a - b)
        return [
          label.length > 60 ? `${label.slice(0, 57)}...` : label,
          String(of.length),
          [...new Set(of.map((e) => e.status))].join('/'),
          fixed(mean((e) => e.headerBytes), 0),
          fixed(mean((e) => e.bodyBytes), 0),
          fixed(mean((e) => e.decodedBytes), 0),
          `${Math.round((of.filter((e) => e.gzipped).length / of.length) * 100)}%`,
          fixed(times[Math.floor(times.length / 2)] ?? 0, 0),
        ]
      }),
    ),
  )
  say()

  // Per person-month, from the units of the month.
  const perMonth = (f: (m: Measured) => number) => measured.reduce((sum, m) => sum + (f(m) / m.units) * monthUnits(m), 0)
  const cpuHere = perMonth((m) => m.cpu.server + m.cpu.postgres) + background / U
  const cpuServerHere = perMonth((m) => m.cpu.server)
  const cpuPostgresHere = perMonth((m) => m.cpu.postgres)
  const originBytes = perMonth((m) => m.exchanges.reduce((s, e) => s + bytesOf(e), 0))
  const wireBytes = perMonth((m) => m.exchanges.reduce((s, e) => s + wireOf(e), 0))
  const requests = perMonth((m) => m.exchanges.length)
  // Each person ran one whole month, so a difference over all people per person is a person-month.
  const delta = (k: keyof Stats) => (afterStats[k] - before.stats[k]) / U

  // Data: live rows (after VACUUM FULL), per person-month. A year of use is 12 of them.
  const growth = (after.tables - before.sizes.tables) / U
  const rawGrowth = (rawAfter.tables - before.sizes.tables) / U
  const expensesPerMonth = profile.webExpenses + profile.agentExpenses
  const yearData = 12 * growth
  // A balance sums every payer and share row of the group (ledgerParts in src/server/balances.ts), so these
  // tables must stay in memory. The activity log and the idempotency keys are read by page or by key.
  const hotGrowth = HOT_TABLES.reduce((sum, name) => sum + ((after.byTable.get(name) ?? 0) - (before.sizes.byTable.get(name) ?? 0)), 0) / U
  const hotYear = 12 * hotGrowth
  const dumpRatio = (fullDump.bytes - emptyDump.bytes) / after.tables
  // Below the ticks' resolution the difference can come out negative; a dump never costs less than nothing.
  const dumpCpuPerByte = Math.max(0, fullDump.cpuSeconds - emptyDump.cpuSeconds) / after.tables

  say('Per person-month (measured):')
  say(`  Requests at the origin: ${fixed(requests, 0)}`)
  say(`  CPU on this machine: ${fixed(cpuHere * 1000, 0)} ms (Bun ${fixed(cpuServerHere * 1000, 0)}, PostgreSQL ${fixed(cpuPostgresHere * 1000, 0)}, background after the run ${fixed((background / U) * 1000, 0)})`)
  say(`  CPU on the target (x${fixed(cpuScale, 2)}): ${fixed(cpuHere * cpuScale * 1000, 0)} ms`)
  say(`  Bytes from the origin: ${kb(originBytes)}; with ${packetOverhead} B per packet (assumed): ${kb(wireBytes)}`)
  say(`  Database growth, live rows: ${kb(growth)} (${kb(growth / expensesPerMonth)} per new expense; expenses, payers and shares ${kb(hotGrowth)}); before VACUUM FULL: ${kb(rawGrowth)}`)
  say(`  Commits ${fixed(delta('commits'), 0)}, WAL ${kb(delta('walBytes'))}, WAL fsyncs ${fixed(delta('walFsyncs'), 0)}, data page writes ${fixed(delta('dataWrites'), 0)}, buffer reads ${fixed(delta('blocks'), 0)} (${fixed(delta('blockReads'), 0)} from the OS)`)
  const grownTables = [...after.byTable.entries()].map(([name, bytes]) => [name, bytes - (before.sizes.byTable.get(name) ?? 0)] as const).filter(([, b]) => b > 0).sort((a, b) => b[1] - a[1]).slice(0, 6)
  say(`  Growth by table: ${grownTables.map(([name, bytes]) => `${name.replace(/^public\./, '')} ${kb(bytes / U)}`).join(', ')}`)
  say(`  Dump (pg_dump -Fc): ${fixed(dumpRatio * 100, 0)}% of the table bytes; ${fixed(fullDump.cpuSeconds * 1000, 0)} ms CPU for ${mb(after.tables)} of tables (${fixed(emptyDump.cpuSeconds * 1000, 0)} ms for an empty database)`)
  say(`  Idle: Bun ${fixed(idleCores.server * 1000, 2)} ms/s, PostgreSQL ${fixed(idleCores.postgres * 1000, 2)} ms/s on this machine`)
  say()

  // ---------- capacity ----------
  const cores = flag('cores')
  const peak = flag('peak-factor')
  const traffic = cpuHere * cpuScale
  const idleTarget = (idleCores.server + idleCores.postgres) * cpuScale
  const dumpsPerMonth = flag('dumps-per-month')
  const dumpFixed = (emptyDump.cpuSeconds * cpuScale * dumpsPerMonth) / SECONDS_PER_MONTH
  // The hourly dump reads all data; after a year each person has yearData of it.
  const dumpPerUser = (dumpCpuPerByte * cpuScale * yearData * dumpsPerMonth) / SECONDS_PER_MONTH
  const cpuUsers = (cores - idleTarget - dumpFixed) / ((traffic * peak) / SECONDS_PER_MONTH + dumpPerUser)
  const dumpShare = (dumpPerUser * cpuUsers) / cores

  const freeEgress = flag('free-egress-gb') * GB
  const backupPerUser = flag('backup-pulls') * dumpRatio * yearData
  const egressPerUser = wireBytes + backupPerUser
  const egressUsers = freeEgress / egressPerUser
  const price = flag('egress-price')
  const cost = (users: number) => Math.max(0, users * egressPerUser - freeEgress) / GB * price

  const disk = flag('disk-gb') * GB
  const dumpsKept = flag('dumps-kept')
  const diskPerUserYear = yearData * (1 + dumpsKept * dumpRatio)
  const diskUsers = disk / diskPerUserYear
  const cache = flag('page-cache-mb') * MB
  const cacheUsers = cache / hotYear
  const writeIops = flag('write-iops')
  const writesPerUser = (delta('walFsyncs') + delta('dataWrites')) / SECONDS_PER_MONTH
  const writeUsers = writeIops / (writesPerUser * peak)
  const readIops = flag('read-iops')
  const coldReadUsers = readIops / ((delta('blocks') / SECONDS_PER_MONTH) * peak)

  const rows: { readonly name: string; readonly users: number; readonly basis: string; readonly binding: boolean }[] = [
    {
      name: 'Sustained CPU',
      users: cpuUsers,
      basis: `${cores} cores; ${fixed(traffic * 1000, 0)} ms per person-month x peak factor ${peak} (assumed); idle ${fixed(idleTarget * 1000, 1)} ms/s; hourly dumps of a year of data take ${fixed(dumpShare * 100, 0)}%`,
      binding: true,
    },
    {
      name: 'Free data out',
      users: egressUsers,
      basis: `${flag('free-egress-gb')} GB/month; ${kb(wireBytes)} of traffic + ${kb(backupPerUser)} of backup pulls (${flag('backup-pulls')} dumps/month of a year of data) per person`,
      binding: true,
    },
    { name: 'Disk, after one year', users: diskUsers, basis: `${flag('disk-gb')} GB usable (assumed); ${kb(yearData)} of data + ${dumpsKept} dumps (${fixed(dumpRatio * 100, 0)}% each) per person-year`, binding: true },
    {
      name: 'Page cache, after one year',
      users: cacheUsers,
      basis: `${flag('page-cache-mb')} MB (assumed); ${kb(hotYear)} per person-year of expenses, payers and shares, which every balance reads in full`,
      binding: true,
    },
    { name: 'Disk writes', users: writeUsers, basis: `${writeIops} IOPS; ${fixed(delta('walFsyncs') + delta('dataWrites'), 0)} WAL fsyncs and page writes per person-month x peak ${peak}`, binding: true },
    { name: 'Disk reads, cache empty (floor)', users: coldReadUsers, basis: `${readIops} IOPS if every buffer read missed the cache; does not bind while the page cache holds the data`, binding: false },
  ]
  const lowest = (of: typeof rows) => of.reduce((a, b) => (b.users < a.users ? b : a))
  const binding = lowest(rows.filter((r) => r.binding))
  const bindingVm = lowest(rows.filter((r) => r.binding && r.name !== 'Free data out'))
  say('Capacity in monthly active people:')
  say(table(['Limit', 'People', 'Basis'], rows.map((r) => [r.name, whole(r.users), r.basis])))
  say()
  say(`Binding limit: ${binding.name}, at about ${whole(binding.users)} monthly active people.`)
  if (bindingVm !== binding) say(`Binding limit of the VM itself (data out paid past the free allowance): ${bindingVm.name}, at about ${whole(bindingVm.users)}.`)
  say(`Free data out without the backup pulls (if the dev box's pull is not billed): about ${whole(freeEgress / wireBytes)} people.`)
  say(`Paid data out at $${price}/GB above ${flag('free-egress-gb')} GB: $${fixed(cost(10_000), 2)}/month for 10,000 people, $${fixed(cost(100_000), 2)}/month for 100,000.`)
  say(
    `Memory at ${concurrency} parallel clients: Bun peak RSS ${mb(peakServer)} (MemoryHigh ${host.serverMemoryHigh}, MemoryMax ${host.serverMemoryMax}); PostgreSQL peak Pss ${mb(peakPostgres)} (MemoryHigh ${host.postgresqlMemoryHigh}, MemoryMax ${host.postgresqlMemoryMax}); ${flag('memory-mb')} MB in the VM. JavaScriptCore sizes its heap from this machine's memory, so the server's peak here does not predict its peak on the target.`,
  )
  say(`Rate limits: every person stayed under ${LIMITS.writesPerMinute} writes/min, ${LIMITS.mcpRequestsPerMinute} MCP requests/min and ${LIMITS.apiKeyRequestsPerMinute} requests/min per API key; a 429 stops the run.`)
  say(`Not counted: cloudflared's and Tailscale's CPU and keepalive traffic, the kernel, and journald.`)
  say(`Run time: ${fixed(measured.reduce((s, m) => s + m.wallSeconds, 0), 0)} s for ${all.length} requests.`)
  console.log(lines.join('\n'))
} catch (error) {
  if (serverLog) {
    const text = await Bun.file(serverLog)
      .text()
      .catch(() => '')
    console.error(`The end of the server's log:\n${text.split('\n').slice(-80).join('\n')}`)
  }
  throw error
} finally {
  await cleanUp()
}
