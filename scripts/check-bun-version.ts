// Fails when the Bun of the dev shell (flake.nix) and @types/bun name different
// versions. CI runs the tests on the dev shell's Bun, and the production
// package (nix/package.nix) uses the same Bun of the flake's nixpkgs.
//   bun scripts/check-bun-version.ts
import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { devDependencies: Record<string, string> }
const types = packageJson.devDependencies['@types/bun'] ?? 'missing'

if (types !== Bun.version) {
  console.error('Bun versions differ: move flake.nix and @types/bun together.', { 'dev shell': Bun.version, '@types/bun': types })
  process.exit(1)
}
console.log(`Bun ${Bun.version} in the dev shell and @types/bun`)
