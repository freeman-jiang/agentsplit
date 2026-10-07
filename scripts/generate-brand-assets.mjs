import { readFile, writeFile } from 'node:fs/promises'
import sharp from 'sharp'

// Render the source-controlled vector mark; no remote fonts or assets.
const source = await readFile('public/brand-mark.svg', 'utf8')
const geometry = source.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
const mark = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#f5f1e8"/><g transform="translate(91 91) scale(3.3)">${geometry}</g></svg>`
await writeFile('public/logo.svg', mark)
await writeFile('src/app/icon.svg', mark)
for (const size of [48, 64, 128, 144, 192, 256, 512]) {
  await sharp(Buffer.from(mark))
    .resize(size, size)
    .png()
    .toFile(`public/logo/${size}x${size}.png`)
}
await sharp(Buffer.from(mark)).png().toFile('public/logo/512x512-maskable.png')
for (const size of [192, 512]) {
  await sharp(Buffer.from(mark))
    .resize(size, size)
    .png()
    .toFile(`public/android-chrome-${size}x${size}.png`)
}
await sharp(Buffer.from(mark))
  .resize(180, 180)
  .png()
  .toFile('src/app/apple-icon.png')
const png = await sharp(Buffer.from(mark)).resize(32, 32).png().toBuffer()
const ico = Buffer.alloc(22)
ico.writeUInt16LE(1, 2)
ico.writeUInt16LE(1, 4)
ico[6] = 32
ico[7] = 32
ico.writeUInt16LE(1, 10)
ico.writeUInt16LE(32, 12)
ico.writeUInt32LE(png.length, 14)
ico.writeUInt32LE(22, 18)
await writeFile('src/app/favicon.ico', Buffer.concat([ico, png]))
const wordmark = `<svg xmlns="http://www.w3.org/2000/svg" width="650" height="160"><rect width="650" height="160" fill="#f5f1e8"/><g transform="translate(8 30)">${geometry}</g><text x="110" y="105" fill="#35392f" font-family="Georgia,serif" font-size="79">AgentSplit</text></svg>`
await sharp(Buffer.from(wordmark)).png().toFile('public/logo-with-text.png')
const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#f5f1e8"/><g transform="translate(70 147) scale(1.25)">${geometry}</g><text x="206" y="250" fill="#35392f" font-family="Georgia,serif" font-size="100">AgentSplit</text><text x="88" y="386" fill="#526044" font-family="Georgia,serif" font-size="54">Shared expenses. Simply settled.</text><text x="88" y="454" fill="#747568" font-family="sans-serif" font-size="28">For people and their agents.</text></svg>`
await sharp(Buffer.from(banner)).png().toFile('public/banner.png')
console.log(
  'Generated AgentSplit application icons, wordmark and share banner.',
)
