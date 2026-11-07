// The server half of `bun run build`, after `vite build` wrote dist/client:
// bundles src/server/main/server.ts and its dependencies into dist/server, so the
// image needs no node_modules, copies the SQL migrations and their journal to
// dist/migrations, and writes .br and .gz copies of the client's text files for src/server/assets.ts.
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

rmSync('dist/server', { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: ['src/server/main/server.ts'],
  outdir: 'dist/server',
  target: 'bun',
  minify: true,
  sourcemap: 'linked',
  // pg loads its optional native binding only when asked for it; the server never asks.
  external: ['pg-native'],
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

rmSync('dist/migrations', { recursive: true, force: true })
// The migrator reads only the SQL files and meta/_journal.json; drizzle-kit's schema snapshots stay out of the image.
cpSync('db/migrations', 'dist/migrations', { recursive: true, filter: (source) => !source.endsWith('_snapshot.json') })

const COMPRESSIBLE = /\.(html|js|css|json|webmanifest|svg|txt|ico)$/
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]))
let compressed = 0
for (const file of files('dist/client')) {
  if (!COMPRESSIBLE.test(file)) continue
  const bytes = readFileSync(file)
  // Small files gain nothing from a copy.
  if (bytes.length < 1024) continue
  writeFileSync(`${file}.br`, brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }))
  writeFileSync(`${file}.gz`, gzipSync(bytes, { level: 9 }))
  compressed++
}
console.log(`Server bundle in dist/server (${result.outputs.length} files); ${compressed} client files precompressed`)
