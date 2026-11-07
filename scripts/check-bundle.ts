// Fails when the JavaScript that every page loads up front (the entry script and
// the chunks index.html preloads) exceeds the budget in docs/v2/BASELINE.md.
//   bun scripts/check-bundle.ts   (after bun run build)
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const BUDGET = 150 * 1024
const html = readFileSync('dist/client/index.html', 'utf8')
const files = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1] ?? '')
let total = 0
for (const file of new Set(files)) {
  const size = gzipSync(readFileSync(`dist/client${file}`), { level: 9 }).length
  total += size
  console.log(`${(size / 1024).toFixed(1).padStart(7)} KB  ${file}`)
}
console.log(`${(total / 1024).toFixed(1).padStart(7)} KB  total up front (budget ${BUDGET / 1024} KB, gzip)`)
if (total > BUDGET) {
  console.error('The up-front JavaScript exceeds the budget. Keep Effect off the client (type-only imports) and split large screens.')
  process.exit(1)
}
