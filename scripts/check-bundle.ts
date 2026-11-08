// Fails when the JavaScript that every page loads up front (the entry script and
// the chunks index.html preloads) exceeds the budget in docs/v2/BASELINE.md, or
// when any client chunk, a lazy route's included, holds Effect's runtime
// (docs/v2/BUILDING.md: the client imports Effect for types only).
//   bun scripts/check-bundle.ts   (after bun run build)
import { readdirSync, readFileSync } from 'node:fs'
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

// Every Effect module names its values with "~effect/<Module>" type IDs, which minification keeps.
const withEffect = readdirSync('dist/client/assets').filter((file) => file.endsWith('.js') && readFileSync(`dist/client/assets/${file}`, 'utf8').includes('~effect/'))
let failed = false
if (total > BUDGET) {
  console.error('The up-front JavaScript exceeds the budget. Keep Effect off the client (type-only imports) and split large screens.')
  failed = true
}
if (withEffect.length) {
  console.error(`Effect's runtime is in the client bundle (${withEffect.join(', ')}). Import the contract with \`import type\`, and keep src/shared modules that the client imports free of Effect.`)
  failed = true
}
if (failed) process.exit(1)
