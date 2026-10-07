import { accessConfigurationSchema } from './mcp/access'
import { prisma } from './prisma'

/** One-time cutover, only after Google proves the configured owner's email. */
export async function bootstrapOwner(user: {
  id: string
  email: string
  emailVerified: boolean
}) {
  if (
    !user.emailVerified ||
    user.email.toLowerCase() !==
      process.env.AUTH_BOOTSTRAP_EMAIL?.trim().toLowerCase()
  )
    return
  if (
    await prisma.authBootstrap.findUnique({
      where: { id: 'private-groups-v1' },
    })
  )
    return
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(170031011)`
      if (
        await tx.authBootstrap.findUnique({
          where: { id: 'private-groups-v1' },
        })
      )
        return
      const groups = await tx.legacyGroupClaim.findMany({
        select: { groupId: true },
      })
      for (const group of groups)
        await tx.userGroupAccess.upsert({
          where: {
            userId_groupId: { userId: user.id, groupId: group.groupId },
          },
          create: { userId: user.id, groupId: group.groupId, role: 'admin' },
          update: { active: true, role: 'admin' },
        })
      if (process.env.MCP_ACCESS_GRANTS) {
        const legacy = accessConfigurationSchema.parse(
          JSON.parse(process.env.MCP_ACCESS_GRANTS),
        )
        // Multiple legacy owners require an explicit mapping, never guess identity.
        const legacyUser =
          process.env.AUTH_BOOTSTRAP_LEGACY_USER_ID ??
          (legacy.users.length === 1 ? legacy.users[0].id : undefined)
        if (!legacyUser) throw new Error('Legacy key owner mapping is required')
        for (const key of legacy.keys.filter((k) => k.userId === legacyUser)) {
          await tx.apikey.create({
            data: {
              id: key.id,
              referenceId: user.id,
              name: `Imported ${key.id}`.slice(0, 32),
              key: Buffer.from(key.tokenSha256, 'hex').toString('base64url'),
              rateLimitTimeWindow: 60_000,
              rateLimitMax: 120,
            },
          })
        }
      }
      await tx.authBootstrap.create({
        data: { id: 'private-groups-v1', userId: user.id },
      })
    },
    { timeout: 30_000 },
  )
}
