import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'

const db = new URL(process.env.POSTGRES_PRISMA_URL ?? '')
assert(
  ['localhost', '127.0.0.1'].includes(db.hostname) &&
    db.pathname.endsWith('_audit_test'),
  'Disposable local audit DB only',
)
const pool = new Pool({ connectionString: db.href }),
  client = await pool.connect()
const namespace = `history_migration_test_${randomBytes(8).toString('hex')}`
try {
  await client.query(`CREATE SCHEMA "${namespace}"`)
  await client.query(`SET search_path TO "${namespace}"`)
  await client.query(`CREATE TABLE "Activity" (id text primary key, "groupId" text NOT NULL, "expenseId" text, "expenseRevision" integer, time timestamp(3) NOT NULL, snapshot jsonb);
 CREATE FUNCTION protect_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END; $$;
 CREATE TRIGGER "Activity_append_only" BEFORE UPDATE OR DELETE ON "Activity" FOR EACH ROW EXECUTE FUNCTION protect_history();
 INSERT INTO "Activity" VALUES
 ('z-create','g','e',1,'2026-10-01 12:00:00.000','{"amount":"60"}'),
 ('a-edit','g','e',2,'2026-10-01 12:00:00.000','{"amount":"90"}'),
 ('m-delete','g','e',3,'2026-10-01 12:00:00.000',null),
 ('b-group','g',null,null,'2026-10-01 11:00:00.000','{"name":"House"}');`)
  const before = (
    await client.query(
      'SELECT to_jsonb(a) AS value FROM "Activity" a ORDER BY id',
    )
  ).rows
  const migration = await readFile(
    new URL(
      '../prisma/migrations/20261002030000_order_history/migration.sql',
      import.meta.url,
    ),
    'utf8',
  )
  await client.query(migration)
  const after = (
    await client.query(
      `SELECT to_jsonb(a)-'sequence' AS value FROM "Activity" a ORDER BY id`,
    )
  ).rows
  assert.deepEqual(after, before)
  const ordered = (
    await client.query(
      'SELECT "expenseRevision" FROM "Activity" WHERE "expenseId"=$1 ORDER BY sequence',
      ['e'],
    )
  ).rows
  assert.deepEqual(
    ordered.map((row) => row.expenseRevision),
    [1, 2, 3],
  )
  const inserted = await client.query(
    `INSERT INTO "Activity" (id,"groupId",time) VALUES ('next','g',now()) RETURNING sequence`,
  )
  assert.equal(inserted.rows[0].sequence, 5)
  await assert.rejects(
    () => client.query(`UPDATE "Activity" SET snapshot='{}' WHERE id='a-edit'`),
    /immutable/,
  )
  console.log(
    'PASS migration preserves contents, orders equal-timestamp expense revisions, advances new events, and restores append-only protection',
  )
} finally {
  await client.query('ROLLBACK')
  await client.query('SET search_path TO public')
  await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`)
  client.release()
  await pool.end()
}
