import { createHash } from 'node:crypto'
import type { OAuthProviderExtension } from '@better-auth/oauth-provider'
import { APIError } from 'better-call'
import { OAUTH_CONNECTION_CLAIM } from './oauth-config'
import { prisma } from './prisma'
import { randomId } from './random'

// Explicit provider storage hook: the same hash is used for provider lookups
// and the connection's immutable original grant identifier. Never store raw tokens.
export const hashOAuthToken = (token: string) =>
  createHash('sha256').update(token).digest('base64url')

/** The official provider handles OAuth; this extension adds application revocation. */
export const connectionClaims: OAuthProviderExtension = {
  claims: {
    accessToken: async ({ user, client, grantType, ctx, scopes }) => {
      if (
        !user?.emailVerified ||
        !['authorization_code', 'refresh_token'].includes(grantType ?? '')
      )
        throw new APIError('FORBIDDEN', {
          error: 'access_denied',
          error_description: 'A verified account grant is required',
        })
      const body = ctx.body as Record<string, unknown>
      let authorizationCodeId: string | null | undefined
      if (grantType === 'authorization_code' && typeof body.code === 'string')
        authorizationCodeId = hashOAuthToken(body.code)
      if (
        grantType === 'refresh_token' &&
        typeof body.refresh_token === 'string'
      ) {
        const refresh = await prisma.oauthRefreshToken.findUnique({
          where: { token: hashOAuthToken(body.refresh_token) },
        })
        if (refresh?.userId === user.id && refresh.clientId === client.clientId)
          authorizationCodeId = refresh.authorizationCodeId
      }
      if (!authorizationCodeId)
        throw new APIError('BAD_REQUEST', { error: 'invalid_grant' })
      const consent = await prisma.oauthConsent.findFirst({
        where: {
          userId: user.id,
          clientId: client.clientId,
          scopes: { hasEvery: scopes },
        },
      })
      if (!consent)
        throw new APIError('FORBIDDEN', {
          error: 'access_denied',
          error_description: 'Consent is no longer active',
        })
      const connection = await prisma.oauthConnection.upsert({
        where: { authorizationCodeId },
        create: {
          id: randomId(),
          authorizationCodeId,
          userId: user.id,
          clientId: client.clientId,
          scopes,
        },
        update: {},
      })
      if (
        connection.revokedAt ||
        connection.userId !== user.id ||
        connection.clientId !== client.clientId
      )
        throw new APIError('BAD_REQUEST', {
          error: 'invalid_grant',
          error_description: 'Connection revoked; connect again',
        })
      return { [OAUTH_CONNECTION_CLAIM]: connection.id }
    },
  },
}

/** Retain the grant tombstone so old JWTs and racing refreshes never regain access. */
export async function revokeOAuthConnection(userId: string, clientId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.oauthConnection.updateMany({
      where: { userId, clientId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    await tx.oauthAccessToken.deleteMany({ where: { userId, clientId } })
    await tx.oauthRefreshToken.deleteMany({ where: { userId, clientId } })
    await tx.oauthConsent.deleteMany({ where: { userId, clientId } })
  })
}
