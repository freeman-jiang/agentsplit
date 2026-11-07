// One-time backfill of receipts.bytes for the receipts stored before migration
// 0012, whose size is known only to storage. It reads each object's size with
// a HEAD request and sets it once (the receipts trigger allows exactly the
// change from 0 to the real size). Rows that already have a size are not
// read. Running it again is safe. Without --apply it only reports.
// The build bundles it as dist/server/backfill-receipt-bytes.js, so it runs in
// the app container with the app's own environment:
//   bun dist/server/backfill-receipt-bytes.js [--apply]
// Env: DATABASE_URL, S3_UPLOAD_ENDPOINT, S3_UPLOAD_KEY, S3_UPLOAD_SECRET,
// and optionally S3_UPLOAD_BUCKET and S3_UPLOAD_REGION, as the server reads them.
import pg from 'pg'
import { receiptKey } from '../src/server/receipts'
import { s3Bucket } from '../src/server/s3'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Set ${name}`)
  return value
}

const apply = process.argv.includes('--apply')
const bucket = s3Bucket({
  endpoint: required('S3_UPLOAD_ENDPOINT'),
  region: process.env['S3_UPLOAD_REGION']?.trim() || 'garage',
  bucket: process.env['S3_UPLOAD_BUCKET']?.trim() || 'agentsplit-receipts',
  accessKeyId: required('S3_UPLOAD_KEY'),
  secretAccessKey: required('S3_UPLOAD_SECRET'),
})
const pool = new pg.Pool({ connectionString: required('DATABASE_URL'), max: 1 })

const { rows } = await pool.query<{ id: string; url: string; created_by: string | null }>(
  `SELECT id, url, created_by FROM receipts WHERE bytes = 0 ORDER BY created_at, id`,
)
console.log(`${rows.length} receipts without a size${apply ? '' : ' (dry run: add --apply to write the sizes)'}`)
let updated = 0
let total = 0
const missing: string[] = []
for (const row of rows) {
  const key = receiptKey(row.url)
  // A missing object stays at 0, so it counts against no one; the failure is reported below.
  const object = key ? await bucket.get(key, { range: { offset: 0, length: 1 } }) : null
  if (!object || object.size <= 0) {
    missing.push(row.id)
    continue
  }
  total += object.size
  console.log(`${row.id}  ${object.size} bytes  ${row.created_by === null ? 'no uploader' : `uploader ${row.created_by}`}`)
  if (apply) {
    const result = await pool.query(`UPDATE receipts SET bytes = $1 WHERE id = $2 AND bytes = 0`, [object.size, row.id])
    updated += result.rowCount ?? 0
  }
}
await pool.end()
console.log(`${apply ? `Set the size of ${updated}` : `Would set the size of ${rows.length - missing.length}`} receipts, ${total} bytes in all.`)
if (missing.length) {
  console.error(`${missing.length} receipts have no object in storage or an unreadable pointer; they keep size 0: ${missing.join(', ')}`)
  process.exitCode = 1
}
