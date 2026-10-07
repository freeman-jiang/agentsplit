import assert from 'node:assert/strict'
import { hashAccessKey } from '../src/lib/mcp/access'
import { prisma } from '../src/lib/prisma'
import { randomId } from '../src/lib/random'

export async function seedTestAgent(
  userId: string,
  token: string,
  groupIds: string[] = [],
) {
  const url = new URL(process.env.POSTGRES_PRISMA_URL ?? '')
  assert(
    ['localhost', '127.0.0.1'].includes(url.hostname) &&
      url.pathname.endsWith('_audit_test'),
  )
  await prisma.user.upsert({
    where: { id: userId },
    create: {
      id: userId,
      name: userId,
      email: `${userId}@example.com`,
      emailVerified: true,
    },
    update: {},
  })
  const apiKey = await prisma.apikey.upsert({
    where: {
      key: Buffer.from(hashAccessKey(token), 'hex').toString('base64url'),
    },
    create: {
      id: randomId(),
      referenceId: userId,
      key: Buffer.from(hashAccessKey(token), 'hex').toString('base64url'),
      rateLimitEnabled: false,
    },
    update: { enabled: true, referenceId: userId },
  })
  for (const groupId of groupIds)
    await prisma.userGroupAccess.upsert({
      where: { userId_groupId: { userId, groupId } },
      create: { userId, groupId, role: 'admin' },
      update: { active: true, role: 'admin' },
    })
  return apiKey.id
}
