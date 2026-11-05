// Copies every receipt object from a backup's receipts.jsonl into an R2 bucket
// under its original key, then reads each one back and compares its size.
// Each line is {"k": key, "s": size, "d": base64 bytes} (devbox/bin/agentsplit-backup).
//
//   bun scripts/copy-receipts.ts <receipts.jsonl> <bucket>
//
// The shared dev Cloudflare token cannot write R2 objects, so the cutover runs
// this one command under `sops exec-env secrets/admin.env` (docs/v2/CUTOVER.md).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [file, bucket] = process.argv.slice(2)
if (!file || !bucket) throw new Error('Usage: bun scripts/copy-receipts.ts <receipts.jsonl> <bucket>')
if (!/^agentsplit-receipts(-preview)?$/.test(bucket)) throw new Error(`Unexpected bucket ${bucket}`)

type Line = { k: string; s: number; d: string }
const objects = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((text) => JSON.parse(text) as Line)

const contentType = (key: string) => (/\.png$/.test(key) ? 'image/png' : /\.jpe?g$/.test(key) ? 'image/jpeg' : null)

const wrangler = (args: string[]) => {
  const run = Bun.spawnSync(['bunx', 'wrangler', 'r2', 'object', ...args, '--remote'], { stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) throw new Error(`wrangler r2 object ${args[0]} ${args[1]} failed: ${run.stderr.toString().trim()}`)
  return run.stdout
}

// The decoded images stay in a private temporary folder and are removed at the end.
const work = mkdtempSync(join(tmpdir(), 'agentsplit-receipts-'))
try {
  for (const [index, o] of objects.entries()) {
    if (/\.\.|[?#%]/.test(o.k)) throw new Error(`Unsafe key ${o.k}`)
    const type = contentType(o.k)
    if (!type) throw new Error(`Unknown content type for ${o.k}`)
    const bytes = Buffer.from(o.d, 'base64')
    if (bytes.length !== o.s) throw new Error(`${o.k}: the backup says ${o.s} bytes, the data has ${bytes.length}`)
    const path = join(work, String(index))
    writeFileSync(path, bytes, { mode: 0o600 })
    wrangler(['put', `${bucket}/${o.k}`, '--file', path, '--content-type', type, '--cache-control', 'private,no-store'])
    const stored = wrangler(['get', `${bucket}/${o.k}`, '--pipe']).length
    if (stored !== o.s) throw new Error(`${o.k}: wrote ${o.s} bytes, read back ${stored}`)
    console.log(`ok  ${o.k} (${o.s} bytes)`)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
console.log(`Copied and checked ${objects.length} objects into ${bucket}`)
