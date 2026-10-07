import { prisma } from '@/lib/prisma'
import { requireWebUser } from '@/lib/session'
import Link from 'next/link'
import { ConnectedApps } from './connected-apps'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Connected apps' }
export default async function ConnectionsPage() {
  const user = await requireWebUser()
  const grants = await prisma.oauthConnection.findMany({
    where: { userId: user.userId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  const clients = await prisma.oauthClient.findMany({
    where: { clientId: { in: grants.map((g) => g.clientId) } },
    select: { clientId: true, name: true },
  })
  const consents = await prisma.oauthConsent.findMany({
    where: {
      userId: user.userId,
      clientId: { in: clients.map((c) => c.clientId) },
    },
    select: { clientId: true, scopes: true },
  })
  const connections = clients
    .filter((c) => consents.some((s) => s.clientId === c.clientId))
    .map((c) => ({
      clientId: c.clientId,
      name: c.name ?? 'Connected app',
      scopes: [
        ...new Set(
          grants
            .filter((g) => g.clientId === c.clientId)
            .flatMap((g) => g.scopes)
            .filter((scope) =>
              consents.some(
                (consent) =>
                  consent.clientId === c.clientId &&
                  consent.scopes.includes(scope),
              ),
            ),
        ),
      ],
    }))
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-8">
      <Link className="text-sm underline" href="/settings">
        Account settings
      </Link>
      <h1 className="font-display text-3xl">Connected apps</h1>
      <p className="text-sm text-muted-foreground">
        Apps authorized through sign-in, such as ChatGPT. Revoking one stops its
        access and refresh tokens immediately. Your API keys are managed
        separately.
      </p>
      <ConnectedApps connections={connections} />
    </main>
  )
}
