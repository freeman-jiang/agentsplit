// Stored OAuth tokens and API keys are hashed: base64url(SHA-256(UTF-8 text)),
// as the current app stored them. If v2 hashed differently, every refresh
// token and API key in the database would stop working at once.
import { expect, it } from 'vitest'
import { sha256Base64url } from '~/server/core/ids'

it('hashes tokens as base64url SHA-256 of their UTF-8 text', () => {
  // The SHA-256 test vectors of FIPS 180-2 ("abc", ""), one character outside ASCII, and a token-shaped string.
  expect(sha256Base64url('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0')
  expect(sha256Base64url('')).toBe('47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU')
  expect(sha256Base64url('é')).toBe('SplVfkAzw1Od4utlRyAXytX5VX96BiWgnxw_biumnEw')
  expect(sha256Base64url('agentsplit_oat_0123456789abcdefghijklmnopqrstuvwxyzABCDEF')).toBe('-iTEPgVLgFA2fcIt0twVU8hffYuzW6yUczDYRRtUv00')
})
