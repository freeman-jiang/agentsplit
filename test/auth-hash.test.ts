// Stored OAuth tokens are hashed. If v2 hashed differently, every imported
// refresh token would stop working, and agents would have to reconnect.
import { createHash } from 'node:crypto'
import fc from 'fast-check'
import { expect, it } from 'vitest'
import { sha256Base64url } from '~/server/ids'

it('hashes OAuth tokens exactly as the current app does', async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ unit: 'binary', maxLength: 300 }), async (token) => {
      expect(sha256Base64url(token)).toBe(createHash('sha256').update(token).digest('base64url'))
    }),
  )
})
