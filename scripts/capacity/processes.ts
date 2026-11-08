// CPU time and memory of processes, read from /proc (Linux only). The capacity
// benchmark reads the server process and the whole PostgreSQL instance with it.
import { readdirSync, readFileSync } from 'node:fs'

/** Clock ticks per second of the utime and stime fields: USER_HZ, 100 on every Linux build that Bun runs on. */
const TICKS = 100

type Stat = { readonly ppid: number; readonly ownSeconds: number; readonly childSeconds: number }

/**
 * The fields of /proc/<pid>/stat that we use, or null when the process is gone.
 * `childSeconds` is the CPU time of the children that the process has waited for.
 */
function stat(pid: number): Stat | null {
  let text: string
  try {
    text = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return null
  }
  // The command name is in parentheses and may hold spaces; the fields after it are plain.
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  const number = (index: number) => Number(fields[index] ?? 'NaN')
  // After the name: state (0), ppid (1), ..., utime (11), stime (12), cutime (13), cstime (14).
  return { ppid: number(1), ownSeconds: (number(11) + number(12)) / TICKS, childSeconds: (number(13) + number(14)) / TICKS }
}

/** Every process whose parent is `pid`. */
function children(pid: number): number[] {
  const found: number[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const child = Number(name)
    if (stat(child)?.ppid === pid) found.push(child)
  }
  return found
}

/** The CPU seconds that `pid` has used, all of its threads together. */
export function processCpuSeconds(pid: number): number {
  const s = stat(pid)
  if (!s) throw new Error(`Process ${pid} is gone`)
  return s.ownSeconds
}

/**
 * The CPU seconds of a PostgreSQL instance: the postmaster, the backends and
 * the background processes that run now, and every child that has ended. The
 * postmaster waits for each child that ends, so the kernel adds that child's
 * whole CPU time to the postmaster's cutime and cstime.
 */
export function instanceCpuSeconds(postmaster: number): number {
  const root = stat(postmaster)
  if (!root) throw new Error(`The postmaster ${postmaster} is gone`)
  let total = root.ownSeconds + root.childSeconds
  for (const child of children(postmaster)) total += stat(child)?.ownSeconds ?? 0
  return total
}

/** A field of /proc/<pid>/status or /proc/<pid>/smaps_rollup in bytes, or 0 when the process is gone. */
function kilobytes(data: { pid: number; file: 'status' | 'smaps_rollup'; field: string }): number {
  try {
    const text = readFileSync(`/proc/${data.pid}/${data.file}`, 'utf8')
    const match = new RegExp(`^${data.field}:\\s+(\\d+) kB$`, 'm').exec(text)
    return Number(match?.[1] ?? '0') * 1024
  } catch {
    return 0
  }
}

/** The peak resident memory of `pid` since it started (VmHWM). */
export const peakRssBytes = (pid: number) => kilobytes({ pid, file: 'status', field: 'VmHWM' })

/** The resident memory of `pid` now (VmRSS). */
export const rssBytes = (pid: number) => kilobytes({ pid, file: 'status', field: 'VmRSS' })

/**
 * The memory of the whole PostgreSQL instance now: the sum of each process's
 * proportional set size (Pss). Pss divides each shared page, such as those of
 * shared_buffers, among the processes that map it, so the sum counts it once.
 */
export function instancePssBytes(postmaster: number): number {
  return [postmaster, ...children(postmaster)].reduce((sum, pid) => sum + kilobytes({ pid, file: 'smaps_rollup', field: 'Pss' }), 0)
}
