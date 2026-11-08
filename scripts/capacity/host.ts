// The production host as the benchmark copies it: its PostgreSQL settings,
// pool size, memory limits and server environment, read from the flake's
// nixosConfigurations.agentsplit (nix/host/default.nix, nix/module.nix), and a
// private PostgreSQL instance that runs with those settings.
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type HostConfig = {
  /** services.postgresql.settings of the host. */
  readonly postgresql: Readonly<Record<string, string | number | boolean | null>>
  readonly postgresqlVersion: string
  readonly poolSize: number
  readonly serverMemoryHigh: string
  readonly serverMemoryMax: string
  readonly postgresqlMemoryHigh: string
  readonly postgresqlMemoryMax: string
  /** The environment of the agentsplit unit, without PATH. */
  readonly serverEnvironment: Readonly<Record<string, string>>
}

/** Runs a command to its end. Throws with its output when it fails. */
export function run(data: { cmd: readonly string[]; env?: Readonly<Record<string, string | undefined>>; cwd?: string }): string {
  const result = Bun.spawnSync([...data.cmd], { env: data.env ?? process.env, cwd: data.cwd ?? process.cwd(), stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`${data.cmd.join(' ')} failed (${result.exitCode}):\n${result.stderr.toString()}${result.stdout.toString()}`)
  return result.stdout.toString()
}

const APPLY = `c: {
  postgresql = c.services.postgresql.settings;
  postgresqlVersion = c.services.postgresql.package.version;
  poolSize = c.services.agentsplit.databasePoolSize;
  serverMemoryHigh = c.services.agentsplit.memoryHigh;
  serverMemoryMax = c.services.agentsplit.memoryMax;
  postgresqlMemoryHigh = c.systemd.services.postgresql.serviceConfig.MemoryHigh;
  postgresqlMemoryMax = c.systemd.services.postgresql.serviceConfig.MemoryMax;
  serverEnvironment = removeAttrs c.systemd.services.agentsplit.environment [ "PATH" ];
}`

/** The production host's settings, from the flake in the working directory. */
export function hostConfig(): HostConfig {
  return JSON.parse(run({ cmd: ['nix', 'eval', '--json', '.#nixosConfigurations.agentsplit.config', '--apply', APPLY] })) as HostConfig
}

/** Settings of the host that name its own files, address or logging; the private instance sets its own. */
const LOCAL_ONLY = new Set(['hba_file', 'ident_file', 'listen_addresses', 'port', 'unix_socket_directories', 'log_destination', 'log_line_prefix'])

export type Instance = {
  /** The directory of the instance's Unix socket: PGHOST for its clients. */
  readonly socketDir: string
  readonly port: number
  readonly postmaster: number
  /** A connection URL for `database` as the superuser, over the Unix socket. */
  readonly url: (database: string) => string
  /** The environment for psql, pg_dump and db-reset against this instance. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stop: () => void
}

/**
 * A new PostgreSQL instance in `dir`, started with the host's settings and
 * reachable only on a Unix socket, as on the host. The benchmark measures it
 * alone: the dev box's shared PostgreSQL runs with fsync off and serves other
 * checkouts, so its CPU time and memory cannot be counted.
 */
export function startInstance(data: { dir: string; port: number; config: HostConfig }): Instance {
  const pgdata = join(data.dir, 'data')
  const socketDir = join(data.dir, 'socket')
  mkdirSync(socketDir, { recursive: true })
  run({ cmd: ['initdb', '--username=postgres', '--auth=trust', '--encoding=UTF8', '--no-locale', pgdata] })
  const settings = Object.entries(data.config.postgresql).flatMap(([name, value]) => (value === null || LOCAL_ONLY.has(name) ? [] : ['-c', `${name}=${String(value)}`]))
  const options = [...settings, '-c', 'listen_addresses=', '-c', `port=${data.port}`, '-c', `unix_socket_directories=${socketDir}`]
  // pg_ctl passes -o to postgres through a shell, so each value is quoted.
  const quoted = options.map((o) => (o === '-c' ? o : `'${o.replaceAll("'", "'\\''")}'`)).join(' ')
  run({ cmd: ['pg_ctl', 'start', '-w', '-D', pgdata, '-l', join(data.dir, 'postgres.log'), '-o', quoted] })
  const postmaster = Number(readFileSync(join(pgdata, 'postmaster.pid'), 'utf8').split('\n')[0])
  const env = { ...process.env, PGHOST: socketDir, PGPORT: String(data.port), PGUSER: 'postgres', PGDATA: pgdata }
  return {
    socketDir,
    port: data.port,
    postmaster,
    url: (database) => `postgresql://postgres@/${database}?host=${socketDir}&port=${data.port}`,
    env,
    stop: () => void run({ cmd: ['pg_ctl', 'stop', '-w', '-m', 'fast', '-D', pgdata], env }),
  }
}
