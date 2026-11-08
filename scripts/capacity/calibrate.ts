// The CPU-only micro-benchmark of scripts/capacity.ts (--calibrate). It uses
// the network, the disk and the database not at all, and imports only Node
// built-ins, so it runs as one file on any machine with Bun, the production
// host included (docs/CAPACITY.md, "Calibration"):
//   bun scripts/capacity/calibrate.ts
// Each work unit does what the server does for one small API answer: it
// builds a JSON document of about 20 KB, encodes it, parses it again, gzips it
// at the server's level (src/server/compression.ts), and takes a SHA-256 of it
// (the session token and API key checks). The score is work units per second
// of one thread, the best of several rounds; the ratio of two machines' scores
// is the CPU scale of the capacity report.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

/** The gzip level of src/server/compression.ts. */
const GZIP_LEVEL = 4
const ROUNDS = 7
const ROUND_MS = 600

/** A small linear congruential generator, so every machine builds the same documents. */
function generator(seed: number) {
  let state = seed
  return () => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
}

/** One work unit. Returns a number that depends on all of the work, so none of it can be skipped. */
function unit(random: () => number): number {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    id: `e${i}-${Math.floor(random() * 1e9).toString(36)}`,
    title: `Shared purchase ${Math.floor(random() * 1000)}`,
    vendor: random() < 0.5 ? 'Costco' : null,
    amount: (Math.floor(random() * 20000) / 100).toFixed(2),
    expenseDate: '2026-11-08',
    payers: [{ participantId: 'p1', amount: '10.00' }],
    shares: [
      { participantId: 'p1', weight: '1' },
      { participantId: 'p2', weight: '1' },
    ],
    attribution: { createdBy: { source: 'web', name: 'Alice Example' }, updatedBy: null },
  }))
  const text = JSON.stringify({ expenses: rows, hasMore: true, nextCursor: 30 })
  const parsed = JSON.parse(text) as { expenses: readonly { amount: string }[] }
  const total = parsed.expenses.reduce((sum, row) => sum + Number(row.amount), 0)
  const body = new TextEncoder().encode(text)
  const zipped = gzipSync(body, { level: GZIP_LEVEL })
  const digest = createHash('sha256').update(body).digest()
  return total + zipped.byteLength + (digest[0] ?? 0)
}

export type Calibration = {
  /** Work units per second of one thread: the best round. */
  readonly score: number
  /** Each round's units per second, in order. */
  readonly rounds: readonly number[]
  readonly machine: string
}

/** Runs the rounds on this thread. Takes about ROUNDS × ROUND_MS plus a warm-up. */
export function calibrate(): Calibration {
  const random = generator(7)
  let sink = 0
  // The JIT compiles the unit before the first round counts.
  for (let i = 0; i < 200; i++) sink += unit(random)
  const rounds: number[] = []
  for (let round = 0; round < ROUNDS; round++) {
    let units = 0
    const start = performance.now()
    while (performance.now() - start < ROUND_MS) {
      sink += unit(random)
      units++
    }
    rounds.push(units / ((performance.now() - start) / 1000))
  }
  if (!Number.isFinite(sink)) throw new Error('Calibration produced no result')
  const cpus = (() => {
    try {
      // The first "model name" line names the CPU on x86_64; aarch64 kernels have none.
      const info = readFileSync('/proc/cpuinfo', 'utf8')
      return /^model name\s*:\s*(.+)$/m.exec(info)?.[1] ?? /^CPU part\s*:\s*(.+)$/m.exec(info)?.[1] ?? 'unknown CPU'
    } catch {
      return 'unknown CPU'
    }
  })()
  return { score: Math.max(...rounds), rounds, machine: `${process.arch}, ${cpus}, Bun ${Bun.version}` }
}

/** The calibration as the report prints it. */
export function calibrationText(result: Calibration): string {
  return [
    `Calibration score: ${Math.round(result.score)} units/s (best of ${result.rounds.length} rounds)`,
    `Rounds: ${result.rounds.map((r) => Math.round(r)).join(' ')}`,
    `Machine: ${result.machine}`,
  ].join('\n')
}

if (import.meta.main) console.log(calibrationText(calibrate()))
