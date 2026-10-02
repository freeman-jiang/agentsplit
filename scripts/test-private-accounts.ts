/** Real PostgreSQL + installed Better Auth integration. Use a disposable local DB. */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { serializeSignedCookie } from 'better-call'
import { POST as mcp } from '../src/app/api/mcp/route'
import { GET as receipt } from '../src/app/api/receipts/route'
import { GET as exportJson } from '../src/app/groups/[groupId]/expenses/export/json/route'
import { getAuth } from '../src/lib/auth'
import { bootstrapOwner } from '../src/lib/auth-bootstrap'
import { groupAccessInput } from '../src/lib/group-access'
import { authenticateMcp } from '../src/lib/mcp/authenticate'
import { prisma } from '../src/lib/prisma'
import { sessionPrincipal } from '../src/lib/session'
import { appRouter } from '../src/trpc/routers/_app'

const db = new URL(process.env.POSTGRES_PRISMA_URL ?? '')
assert(
  ['127.0.0.1', 'localhost'].includes(db.hostname),
  'Local disposable DB only',
)
assert(
  db.pathname.includes('e2e') || db.pathname.includes('test'),
  'Use a test database',
)
const auth = getAuth(),
  context = await auth.$context,
  base = process.env.BASE_URL!
let passed = 0
const check = async (name: string, run: () => Promise<void>) => {
  await run()
  console.log(`PASS ${name}`)
  passed++
}
const suffix = randomBytes(5).toString('hex')
async function identity(label: string, verified = true) {
  const user = await prisma.user.create({
    data: {
      id: `auth-${label}-${suffix}`,
      name: label,
      email: `${label}-${suffix}@example.com`,
      emailVerified: verified,
    },
  })
  const session = await context.internalAdapter.createSession(user.id)
  const signed = await serializeSignedCookie(
    context.authCookies.sessionToken.name,
    session.token,
    process.env.BETTER_AUTH_SECRET!,
  )
  const headers = new Headers({
    cookie: signed.split(';')[0],
    origin: base,
    'content-type': 'application/json',
  })
  return { user, headers }
}
const alice = await identity('alice'),
  bob = await identity('bob'),
  outsider = await identity('outsider'),
  unverified = await identity('unverified', false)
const alicePrincipal = await sessionPrincipal(alice.headers)
assert(alicePrincipal)
const caller = appRouter.createCaller({ principal: alicePrincipal })
const form = {
  name: `Private auth test ${suffix}`,
  currency: '$',
  currencyCode: 'USD',
  participants: [{ name: 'Alice' }, { name: 'Bob' }],
}
const group = await caller.groups.create({ groupFormValues: form })
alicePrincipal.groupIds.push(group.groupId)
const groupId = group.groupId
const bobPrincipal = (await sessionPrincipal(bob.headers))!,
  bobCaller = appRouter.createCaller({ principal: bobPrincipal })
await check('anonymous API blocked', async () => {
  await assert.rejects(
    () => appRouter.createCaller({}).groups.get({ groupId }),
    /Sign in required/,
  )
})
await check('unverified session rejected', async () => {
  assert.equal(await sessionPrincipal(unverified.headers), undefined)
})
await check('group creation gives creator admin', async () => {
  assert.equal(
    (await caller.groups.getDetails({ groupId })).access.role,
    'admin',
  )
})
await check('uninvited account cannot read or update', async () => {
  await assert.rejects(() => bobCaller.groups.get({ groupId }), /access denied/)
  await assert.rejects(
    () =>
      bobCaller.groups.update({
        groupId,
        groupFormValues: { name: 'stolen' },
        expectedRevision: 1,
      }),
    /access denied/,
  )
})
await check('group URL no longer grants access', async () => {
  await assert.rejects(
    () =>
      bobCaller.groups.access({
        action: 'join',
        shareUrl: `${base}/groups/${groupId}`,
      }),
    /invitation/,
  )
})
let invitation: string
await check('admin creates email-bound invitation', async () => {
  const result = await caller.groups.access({
    action: 'invite',
    groupId,
    email: bob.user.email,
  })
  assert(result.invitation)
  invitation = result.invitation.url
})
await check('wrong email cannot accept', async () => {
  const principal = (await sessionPrincipal(outsider.headers))!
  await assert.rejects(
    () =>
      appRouter
        .createCaller({ principal })
        .groups.access({ action: 'join', shareUrl: invitation }),
    /different email/,
  )
})
await check('right verified email accepts', async () => {
  assert(
    (await bobCaller.groups.access({ action: 'join', shareUrl: invitation }))
      .joined,
  )
  bobPrincipal.groupIds.push(groupId)
  assert.equal(
    (await bobCaller.groups.getDetails({ groupId })).access.role,
    'member',
  )
})
await check('accept retry is safe', async () => {
  assert(
    (await bobCaller.groups.access({ action: 'join', shareUrl: invitation }))
      .joined,
  )
})
await check('member cannot manage settings or invitations', async () => {
  await assert.rejects(
    () =>
      bobCaller.groups.update({
        groupId,
        groupFormValues: { name: 'no' },
        expectedRevision: 1,
      }),
    /admins/,
  )
  await assert.rejects(
    () =>
      bobCaller.groups.access({
        action: 'invite',
        groupId,
        email: outsider.user.email,
      }),
    /admins/,
  )
})
const expenseForm = {
  title: 'Exact mixed ledger',
  expenseDate: new Date('2026-10-01'),
  amount: '12.01',
  currencyCode: 'USD' as const,
  category: 0,
  paidBy: group.group.participants[0].id,
  paidFor: group.group.participants.map((p) => ({
    participant: p.id,
    shares: '1',
  })),
  splitMode: 'EVENLY' as const,
  isReimbursement: false,
  documents: [],
  notes: '',
  recurrenceRule: 'NONE' as const,
}
const expense = await bobCaller.groups.expenses.create({
  groupId,
  expenseFormValues: expenseForm,
  participantId: group.group.participants[0].id,
})
await check('member writes expenses, server records real actor', async () => {
  const activity = await prisma.activity.findFirstOrThrow({
    where: { expenseId: expense.expenseId },
  })
  assert.equal(activity.actorUserId, bob.user.id)
  assert.equal(activity.actorName, 'bob')
  assert.equal(activity.source, 'web')
  assert.equal(activity.agentKeyId, null)
})
await check('revision conflicts rejected', async () => {
  await assert.rejects(
    () =>
      bobCaller.groups.expenses.update({
        groupId,
        expenseId: expense.expenseId,
        expectedRevision: 0,
        expenseFormValues: { title: 'bad' },
      }),
    /changed/,
  )
})
await check('cannot attach arbitrary or other-group URLs', async () => {
  await assert.rejects(
    () =>
      bobCaller.groups.expenses.update({
        groupId,
        expenseId: expense.expenseId,
        expectedRevision: 1,
        expenseFormValues: {
          documents: [
            {
              id: 'x',
              url: 'https://example.com/secret.png',
              width: 10,
              height: 10,
            },
          ],
        },
      }),
    /uploaded to this group/,
  )
})
let key: string, keyId: string
await check('self-service key create uses signed-in owner', async () => {
  const r = await auth.handler(
    new Request(`${base}/api/auth/api-key/create`, {
      method: 'POST',
      headers: bob.headers,
      body: JSON.stringify({ name: 'integration' }),
    }),
  )
  const value = (await r.json()) as {
    key: string
    id: string
    referenceId: string
  }
  assert.equal(r.status, 200)
  assert.equal(value.referenceId, bob.user.id)
  key = value.key
  keyId = value.id
})
await check('key verifies against membership', async () => {
  const result = await authenticateMcp(
    new Request(`${base}/api/mcp`, {
      headers: { authorization: `Bearer ${key}` },
    }),
  )
  assert('principal' in result)
  assert.deepEqual(result.principal.groupIds, [groupId])
})
await check(
  'raw API key authenticates MCP, exports and receipt access without a prefix',
  async () => {
    const headers = { 'X-API-Key': key }
    const result = await authenticateMcp(
      new Request(`${base}/api/mcp`, { headers }),
    )
    assert('principal' in result)
    assert.equal(result.principal.userId, bob.user.id)
    const exported = await exportJson(
      new Request(`${base}/export`, { headers }),
      { params: Promise.resolve({ groupId }) },
    )
    assert.equal(exported.status, 200)
    const image = await receipt(
      new Request(
        `${base}/api/receipts?${new URLSearchParams({ groupId, url: 'https://example.com/nonexistent.png' })}`,
        { headers },
      ),
    )
    assert.equal(image.status, 404)
    const response = await mcp(
      new Request(`${base}/api/mcp`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          accept: 'application/json,text/event-stream',
          'mcp-protocol-version': '2025-03-26',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      }),
    )
    assert.equal(response.status, 200)
    const raw = await response.text()
    const json = JSON.parse(
      raw
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6) ?? raw,
    ) as { result: { tools: unknown[] } }
    assert.equal(json.result.tools.length, 17)
    const conflicting = await authenticateMcp(
      new Request(`${base}/api/mcp`, {
        headers: { ...headers, authorization: `Bearer ${key}-other` },
      }),
    )
    assert('response' in conflicting)
    assert.equal(conflicting.response.status, 401)
  },
)
await check(
  'key cannot mint another key or act as browser session',
  async () => {
    const r = await auth.handler(
      new Request(`${base}/api/auth/api-key/create`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: base,
          'x-api-key': key,
        },
        body: JSON.stringify({ name: 'unauthorized', userId: alice.user.id }),
      }),
    )
    assert(r.status >= 400)
  },
)
await check('MCP discovery and tools execute through real key', async () => {
  for (const [method, params] of [
    ['tools/list', {}],
    ['tools/call', { name: 'get_group', arguments: { groupId } }],
  ] as const) {
    const r = await mcp(
      new Request(`${base}/api/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-03-26',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    )
    assert.equal(r.status, 200)
    const body = await r.text()
    const data = body.startsWith('event:')
      ? body
          .split('\n')
          .find((line) => line.startsWith('data:'))!
          .slice(5)
      : body
    const value = JSON.parse(data) as {
      result: {
        isError?: boolean
        tools?: unknown[]
        structuredContent?: unknown
      }
    }
    assert(!value.result.isError)
    if (method === 'tools/list') assert.equal(value.result.tools?.length, 17)
  }
})
await check('JSON exports require membership for direct URLs', async () => {
  const params = { params: Promise.resolve({ groupId }) }
  assert.equal(
    (await exportJson(new Request(`${base}/export`), params)).status,
    401,
  )
  assert.equal(
    (
      await exportJson(
        new Request(`${base}/export`, { headers: outsider.headers }),
        params,
      )
    ).status,
    403,
  )
  assert.equal(
    (
      await exportJson(
        new Request(`${base}/export`, { headers: bob.headers }),
        params,
      )
    ).status,
    200,
  )
})
await check(
  'receipts require group membership before reading storage',
  async () => {
    const requestUrl = `${base}/api/receipts?${new URLSearchParams({ groupId, url: 'https://example.com/receipt.png' })}`
    assert.equal((await receipt(new Request(requestUrl))).status, 401)
    assert.equal(
      (await receipt(new Request(requestUrl, { headers: outsider.headers })))
        .status,
      403,
    )
  },
)
await check('last admin cannot leave', async () => {
  await assert.rejects(
    () => caller.groups.access({ action: 'leave', groupId }),
    /last admin/,
  )
})
await check(
  'removal immediately revokes stale web and agent group access',
  async () => {
    await caller.groups.access({
      action: 'remove_member',
      groupId,
      userId: bob.user.id,
    })
    await assert.rejects(
      () => bobCaller.groups.get({ groupId }),
      /access denied/,
    )
    await assert.rejects(
      () =>
        bobCaller.groups.expenses.create({
          groupId,
          expenseFormValues: expenseForm,
        }),
      /access denied/,
    )
    const authResult = await authenticateMcp(
      new Request(`${base}/api/mcp`, {
        headers: { authorization: `Bearer ${key}` },
      }),
    )
    assert('principal' in authResult)
    assert.deepEqual(authResult.principal.groupIds, [])
  },
)
await check('consumed invitation cannot undo removal', async () => {
  await assert.rejects(
    () => bobCaller.groups.access({ action: 'join', shareUrl: invitation }),
    /already used/,
  )
})
await check('revoked invitation rejected', async () => {
  const result = await caller.groups.access({
    action: 'invite',
    groupId,
    email: bob.user.email,
  })
  assert(result.invitation)
  await caller.groups.access({
    action: 'revoke_invitation',
    groupId,
    invitationId: result.invitation.id,
  })
  await assert.rejects(
    () =>
      bobCaller.groups.access({
        action: 'join',
        shareUrl: result.invitation!.url,
      }),
    /revoked/,
  )
})
await check('expired invitation rejected', async () => {
  const result = await caller.groups.access({
    action: 'invite',
    groupId,
    email: bob.user.email,
  })
  assert(result.invitation)
  await prisma.groupInvitation.update({
    where: { id: result.invitation.id },
    data: { expiresAt: new Date(0) },
  })
  await assert.rejects(
    () =>
      bobCaller.groups.access({
        action: 'join',
        shareUrl: result.invitation!.url,
      }),
    /expired/,
  )
})
await check('one user cannot revoke another user key', async () => {
  const r = await auth.handler(
    new Request(`${base}/api/auth/api-key/delete`, {
      method: 'POST',
      headers: alice.headers,
      body: JSON.stringify({ keyId }),
    }),
  )
  assert(r.status >= 400)
})
await check('key revocation is effective', async () => {
  const r = await auth.handler(
    new Request(`${base}/api/auth/api-key/delete`, {
      method: 'POST',
      headers: bob.headers,
      body: JSON.stringify({ keyId }),
    }),
  )
  assert.equal(r.status, 200)
  const result = await authenticateMcp(
    new Request(`${base}/api/mcp`, {
      headers: { authorization: `Bearer ${key}` },
    }),
  )
  assert('response' in result)
  assert.equal(result.response.status, 401)
})
await check('revoked raw keys cannot authenticate', async () => {
  const result = await authenticateMcp(
    new Request(`${base}/api/mcp`, { headers: { 'X-API-Key': key } }),
  )
  assert('response' in result)
  assert.equal(result.response.status, 401)
})
await check('access parser requires action-specific inputs', async () => {
  assert(!groupAccessInput.safeParse({ action: 'invite', groupId }).success)
  assert(
    !groupAccessInput.safeParse({
      action: 'set_role',
      groupId,
      userId: alice.user.id,
    }).success,
  )
})
await check('unverified identity never bootstraps ownership', async () => {
  process.env.AUTH_BOOTSTRAP_EMAIL = unverified.user.email
  await bootstrapOwner(unverified.user)
  assert.equal(
    await prisma.userGroupAccess.count({
      where: { userId: unverified.user.id },
    }),
    0,
  )
  delete process.env.AUTH_BOOTSTRAP_EMAIL
})
await check(
  'bootstrap imports only captured groups and old keys once',
  async () => {
    // This suite's startup guards prohibit production; reset only the test cutover marker.
    await prisma.authBootstrap.deleteMany({
      where: { id: 'private-groups-v1' },
    })
    const inheritedToken = randomBytes(32).toString('base64url'),
      inheritedId = `legacy-${suffix}`
    process.env.AUTH_BOOTSTRAP_EMAIL = alice.user.email
    process.env.MCP_ACCESS_GRANTS = JSON.stringify({
      users: [{ id: 'old-owner', groupIds: [] }],
      keys: [
        {
          id: inheritedId,
          userId: 'old-owner',
          tokenSha256: createHash('sha256')
            .update(inheritedToken)
            .digest('hex'),
        },
      ],
    })
    const otherGroup = await appRouter
      .createCaller({ principal: (await sessionPrincipal(outsider.headers))! })
      .groups.create({ groupFormValues: form })
    await bootstrapOwner(alice.user)
    assert.equal(
      await prisma.userGroupAccess.findUnique({
        where: {
          userId_groupId: {
            userId: alice.user.id,
            groupId: otherGroup.groupId,
          },
        },
      }),
      null,
    )
    const imported = await authenticateMcp(
      new Request(`${base}/api/mcp`, {
        headers: { authorization: `Bearer ${inheritedToken}` },
      }),
    )
    assert('principal' in imported)
    assert.equal(imported.principal.userId, alice.user.id)
    await prisma.apikey.delete({ where: { id: inheritedId } })
    await bootstrapOwner(alice.user)
    assert.equal(
      await prisma.apikey.findUnique({ where: { id: inheritedId } }),
      null,
    )
    delete process.env.MCP_ACCESS_GRANTS
    delete process.env.AUTH_BOOTSTRAP_EMAIL
  },
)
console.log(
  `${passed} private-account integration checks passed. Group ${groupId}`,
)
await prisma.$disconnect()
