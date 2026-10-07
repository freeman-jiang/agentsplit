import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { BrowserContext } from '@playwright/test'
import { serializeSignedCookie } from 'better-call'
import { Pool } from 'pg'

const testUsers = new WeakMap<BrowserContext, string>()

/** Test-only DB seeding. No production auth bypass or test endpoint is shipped. */
export async function seedAccount(context: BrowserContext, baseURL: string) {
  const url = new URL(process.env.POSTGRES_PRISMA_URL ?? '')
  assert(
    ['localhost', '127.0.0.1'].includes(url.hostname) &&
      /test|e2e/.test(url.pathname),
    'E2E requires a disposable loopback database',
  )
  assert(
    ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname),
    'Never seed production sessions',
  )
  const secret = process.env.BETTER_AUTH_SECRET
  assert(
    secret && secret.length >= 32,
    'Set the test server BETTER_AUTH_SECRET',
  )
  const id = `e2e-${randomBytes(10).toString('hex')}`,
    token = randomBytes(32).toString('hex'),
    email = `${id}@example.com`
  const pool = new Pool({ connectionString: url.href })
  try {
    await pool.query(
      'INSERT INTO "User" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$2,$3,true,now(),now())',
      [id, 'E2E Owner', email],
    )
    await pool.query(
      'INSERT INTO "Session" (id,token,"userId","expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,now()+interval \'1 hour\',now(),now())',
      [`${id}-session`, token, id],
    )
  } finally {
    await pool.end()
  }
  const cookie = await serializeSignedCookie(
    'better-auth.session_token',
    token,
    secret,
  )
  await context.addCookies([
    {
      name: 'better-auth.session_token',
      value: cookie.split(';')[0].slice('better-auth.session_token='.length),
      url: baseURL,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
  testUsers.set(context, id)
  return { id, email }
}

/** Fixture identity only: set the account name before creating a group through the UI. */
export async function setTestAccountName(
  context: BrowserContext,
  name: string,
) {
  const id = testUsers.get(context)
  assert(id, 'Only a session created by seedAccount may be changed')
  const url = new URL(process.env.POSTGRES_PRISMA_URL ?? '')
  assert(
    ['localhost', '127.0.0.1'].includes(url.hostname) &&
      /test|e2e/.test(url.pathname),
  )
  const pool = new Pool({ connectionString: url.href })
  try {
    await pool.query('UPDATE "User" SET name=$1 WHERE id=$2', [name, id])
  } finally {
    await pool.end()
  }
}
