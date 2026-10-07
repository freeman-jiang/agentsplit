import { OAUTH_SCOPES } from '@/lib/oauth-config'
import { prisma } from '@/lib/prisma'
import { requireWebUser } from '@/lib/session'
import { z } from 'zod'
import { ConsentForm } from './consent-form'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Connect an app' }
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requireWebUser()
  const query = await searchParams
  const clientId = typeof query.client_id === 'string' ? query.client_id : ''
  const scopes =
    typeof query.scope === 'string'
      ? query.scope.split(' ').filter(Boolean)
      : []
  const claimsSchema = z.object({
    userinfo: z.record(z.string().max(80), z.unknown()).optional(),
    id_token: z.record(z.string().max(80), z.unknown()).optional(),
  })
  let requestedClaims: string[] = []
  let claimsValid = query.claims === undefined
  if (typeof query.claims === 'string' && query.claims.length <= 8192) {
    try {
      const parsed = claimsSchema.safeParse(JSON.parse(query.claims))
      claimsValid = parsed.success
      if (parsed.success)
        requestedClaims = [
          ...new Set([
            ...Object.keys(parsed.data.userinfo ?? {}),
            ...Object.keys(parsed.data.id_token ?? {}),
          ]),
        ]
    } catch {
      claimsValid = false
    }
  }
  const client = clientId
    ? await prisma.oauthClient.findUnique({
        where: { clientId },
        select: { name: true, disabled: true },
      })
    : null
  if (
    !claimsValid ||
    !client ||
    client.disabled ||
    typeof query.sig !== 'string' ||
    !scopes.length ||
    scopes.some((s) => !OAUTH_SCOPES.includes(s))
  )
    return (
      <main className="mx-auto max-w-lg px-4 py-12">
        <h1 className="break-words font-display text-3xl">
          Start the connection again
        </h1>
        <p className="mt-4">
          This authorization request is incomplete or unsupported. Return to the
          app you are connecting and try again.
        </p>
      </main>
    )
  return (
    <main className="mx-auto max-w-lg space-y-6 px-4 py-12">
      <h1 className="break-words font-display text-3xl">
        Connect {client.name ?? 'this app'} to AgentSplit
      </h1>
      <p className="text-sm text-muted-foreground">Signed in as {user.email}</p>
      <p className="break-all text-xs text-muted-foreground">
        Client identity: {clientId}
      </p>
      <ConsentForm scopes={scopes} requestedClaims={requestedClaims} />
    </main>
  )
}
