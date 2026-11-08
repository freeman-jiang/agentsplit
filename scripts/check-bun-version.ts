// Fails when the Bun of the dev shell (flake.nix), the Bun images of the
// Dockerfile and @types/bun name different versions. CI runs the tests on the
// dev shell's Bun and production runs the image's, so they must move together.
//   bun scripts/check-bun-version.ts
import { readFileSync } from 'node:fs'

const dockerfile = readFileSync('Dockerfile', 'utf8')
const images = [...dockerfile.matchAll(/^ARG BUN_\w+=oven\/bun:(\d+\.\d+\.\d+)/gm)].map((m) => m[1])
const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { devDependencies: Record<string, string> }
const versions = { 'dev shell': Bun.version, 'Dockerfile images': [...new Set(images)].join(', '), '@types/bun': packageJson.devDependencies['@types/bun'] ?? 'missing' }

if (images.length < 2 || Object.values(versions).some((v) => v !== Bun.version)) {
  console.error('Bun versions differ: move flake.nix, the Dockerfile images and @types/bun together.', versions)
  process.exit(1)
}
console.log(`Bun ${Bun.version} in the dev shell, the Dockerfile images and @types/bun`)
