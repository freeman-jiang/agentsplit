// Copies every object of one S3 bucket into another, with its content type:
// the receipts between Garage on Coolify and Cloudflare R2 on the NixOS host
// (DEPLOYMENT.md, "Roll back to Coolify"). An object that the target
// already holds with the same size and type is skipped, so a second run copies
// only the new objects. Each copy is read back and compared. It never deletes.
//   SOURCE_S3_ENDPOINT=... SOURCE_S3_REGION=garage SOURCE_S3_BUCKET=... SOURCE_S3_KEY=... SOURCE_S3_SECRET=... \
//   TARGET_S3_ENDPOINT=... TARGET_S3_REGION=auto TARGET_S3_BUCKET=... TARGET_S3_KEY=... TARGET_S3_SECRET=... \
//   bun scripts/copy-receipts.ts [--check]
// With --check it copies nothing and fails when an object differs or is missing.
import { S3Client, type S3Stats } from 'bun'

const check = process.argv.includes('--check')

function bucket(prefix: 'SOURCE' | 'TARGET'): S3Client {
  const setting = (name: string) => {
    const value = process.env[`${prefix}_S3_${name}`]?.trim()
    if (!value) throw new Error(`Set ${prefix}_S3_${name}`)
    return value
  }
  // Path-style URLs, as the server uses (src/server/s3.ts): Garage needs them and R2 accepts them.
  return new S3Client({
    endpoint: setting('ENDPOINT'),
    region: setting('REGION'),
    bucket: setting('BUCKET'),
    accessKeyId: setting('KEY'),
    secretAccessKey: setting('SECRET'),
    virtualHostedStyle: false,
  })
}

const notFound = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'NoSuchKey'

async function statOrNull(client: S3Client, key: string): Promise<S3Stats | null> {
  try {
    return await client.file(key).stat()
  } catch (error) {
    if (notFound(error)) return null
    throw error
  }
}

async function* keys(client: S3Client): AsyncGenerator<string> {
  let token: string | undefined
  do {
    const page = await client.list(token ? { continuationToken: token } : {})
    for (const object of page.contents ?? []) yield object.key
    token = page.isTruncated ? page.nextContinuationToken : undefined
    if (page.isTruncated && !token) throw new Error('The source listing is truncated without a continuation token')
  } while (token)
}

const same = (a: S3Stats, b: S3Stats | null) => b !== null && a.size === b.size && a.type === b.type

const source = bucket('SOURCE')
const target = bucket('TARGET')
let total = 0
let copied = 0
const differ: string[] = []
for await (const key of keys(source)) {
  total++
  const want = await source.file(key).stat()
  if (same(want, await statOrNull(target, key))) continue
  if (check) {
    differ.push(key)
    continue
  }
  const bytes = await source.file(key).bytes()
  if (bytes.length !== want.size) throw new Error(`${key}: read ${bytes.length} bytes of ${want.size}`)
  await target.write(key, bytes, { type: want.type })
  const back = await target.file(key).bytes()
  const stored = await target.file(key).stat()
  if (stored.type !== want.type || !Buffer.from(back).equals(Buffer.from(bytes))) throw new Error(`${key}: the copy differs from the source`)
  copied++
}

if (check) {
  if (differ.length) {
    console.error(`copy-receipts: ${differ.length} of ${total} objects are missing or differ in the target:\n${differ.join('\n')}`)
    process.exit(1)
  }
  console.log(`copy-receipts: the target holds all ${total} objects with the same size and type`)
} else {
  console.log(`copy-receipts: ${copied} copied, ${total - copied} already in the target, ${total} in the source`)
}
