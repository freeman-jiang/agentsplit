/** @jest-environment node */
import { hasApiKeyHeader, readApiKey } from './api-key-header'

const key = 'agentsplit_example-key-with-at-least-thirty-two-characters'

describe('API key headers', () => {
  it('accepts the copied key as-is in X-API-Key, with case-insensitive header names', () => {
    expect(readApiKey(new Headers({ 'X-API-Key': key }))).toBe(key)
    expect(readApiKey(new Headers({ 'x-api-key': key }))).toBe(key)
  })
  it('preserves standard bearer client compatibility', () => {
    expect(readApiKey(new Headers({ Authorization: `Bearer ${key}` }))).toBe(
      key,
    )
    expect(readApiKey(new Headers({ Authorization: `bearer ${key}` }))).toBe(
      key,
    )
  })
  it('accepts identical credentials but rejects conflicting identities', () => {
    expect(
      readApiKey(
        new Headers({ 'X-API-Key': key, Authorization: `Bearer ${key}` }),
      ),
    ).toBe(key)
    expect(
      readApiKey(
        new Headers({ 'X-API-Key': key, Authorization: `Bearer ${key}-other` }),
      ),
    ).toBeUndefined()
  })
  it.each([
    '',
    'short',
    `Bearer ${key}`,
    `${key},${key}`,
    `${key} extra`,
    'x'.repeat(4097),
  ])('rejects malformed raw credentials', (value) => {
    expect(readApiKey(new Headers({ 'X-API-Key': value }))).toBeUndefined()
  })
  it('does not fall back to a valid credential when another supplied header is malformed', () => {
    expect(
      readApiKey(
        new Headers({ 'X-API-Key': key, Authorization: 'Basic credentials' }),
      ),
    ).toBeUndefined()
    expect(
      readApiKey(
        new Headers({ 'X-API-Key': '', Authorization: `Bearer ${key}` }),
      ),
    ).toBeUndefined()
  })
  it('distinguishes explicit credentials from browser-session requests', () => {
    expect(hasApiKeyHeader(new Headers())).toBe(false)
    expect(hasApiKeyHeader(new Headers({ 'X-API-Key': '' }))).toBe(true)
    expect(hasApiKeyHeader(new Headers({ Authorization: 'invalid' }))).toBe(
      true,
    )
    expect(readApiKey(new Headers())).toBeUndefined()
  })
})
