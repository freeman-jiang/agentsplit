/** @jest-environment node */

import {
  accessConfigurationSchema,
  assertGroupAccess,
  authorizeMcpRequest,
  hashAccessKey,
} from './access'

const token = 'test-only-agent-key-with-more-than-thirty-two-characters'
const grant = {
  id: 'alice-codex',
  userId: 'alice',
  tokenSha256: hashAccessKey(token),
}
const user = { id: 'alice', groupIds: ['group-a'] }
const principal = {
  id: grant.id,
  userId: grant.userId,
  groupIds: user.groupIds,
}
const config = JSON.stringify({ users: [user], keys: [grant] })
function request(authorization?: string, origin?: string) {
  return new Request('https://app.test/api/mcp', {
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(origin ? { origin } : {}),
    },
  })
}

describe('MCP access grants', () => {
  it('derives identity and permissions from the verified key', () => {
    expect(authorizeMcpRequest(request(`Bearer ${token}`), config)).toEqual({
      principal: { id: 'alice-codex', userId: 'alice', groupIds: ['group-a'] },
    })
  })

  it.each([
    undefined,
    'Bearer wrong-key-that-is-long-enough-to-be-valid-length',
  ])('rejects a missing or invalid credential', (authorization) => {
    const result = authorizeMcpRequest(request(authorization), config)
    expect('response' in result && result.response.status).toBe(401)
  })

  it('stays disabled without any configured grants', () => {
    const result = authorizeMcpRequest(request(`Bearer ${token}`), '')
    expect('response' in result && result.response.status).toBe(404)
  })

  it('fails closed on malformed authorization configuration', async () => {
    const result = authorizeMcpRequest(request(`Bearer ${token}`), '{broken')
    expect('response' in result && result.response.status).toBe(503)
    if ('response' in result) {
      expect(await result.response.text()).not.toContain(token)
    }
  })

  it('rejects browser requests from an unrelated origin', () => {
    const result = authorizeMcpRequest(
      request(`Bearer ${token}`, 'https://untrusted.test'),
      config,
    )
    expect('response' in result && result.response.status).toBe(403)
  })

  it.each(['untrusted.test', '[invalid-ipv6', 'app.test/unexpected'])(
    'rejects an unrelated or malformed Host even with a valid credential: %s',
    (host) => {
      const req = request(`Bearer ${token}`)
      req.headers.set('host', host)
      const result = authorizeMcpRequest(req, config)
      expect('response' in result && result.response.status).toBe(403)
    },
  )

  it('rejects credentials ambiguously assigned to two identities', () => {
    expect(() =>
      accessConfigurationSchema.parse({
        users: [user],
        keys: [grant, { ...grant, id: 'other-agent' }],
      }),
    ).toThrow('Duplicate access key')
  })

  it('denies access to groups outside the credential grant', () => {
    expect(() =>
      assertGroupAccess(
        'groups.get',
        { groupId: 'group-b', userId: 'bob' },
        principal,
      ),
    ).toThrow('cannot access')
    expect(() =>
      assertGroupAccess(
        'groups.list',
        { groupIds: ['group-a', 'group-b'] },
        principal,
      ),
    ).toThrow('cannot access')
  })

  it('accepts granted groups and public categories', () => {
    expect(() =>
      assertGroupAccess('groups.get', { groupId: 'group-a' }, principal),
    ).not.toThrow()
    expect(() =>
      assertGroupAccess('categories.list', {}, principal),
    ).not.toThrow()
  })

  it('applies user access changes to every key without rotating credentials', () => {
    const secondToken = 'another-test-only-agent-key-with-thirty-two-characters'
    const expanded = JSON.stringify({
      users: [{ ...user, groupIds: ['group-a', 'group-b'] }],
      keys: [
        grant,
        {
          ...grant,
          id: 'alice-second-agent',
          tokenSha256: hashAccessKey(secondToken),
        },
      ],
    })
    for (const agentToken of [token, secondToken]) {
      const result = authorizeMcpRequest(
        request(`Bearer ${agentToken}`),
        expanded,
      )
      expect('principal' in result && result.principal.groupIds).toEqual([
        'group-a',
        'group-b',
      ])
    }
  })
})
