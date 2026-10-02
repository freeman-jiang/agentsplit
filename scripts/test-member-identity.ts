/** Real DB and tRPC/MCP contract checks. No production data or sessions. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createGroup } from '../src/lib/api'
import { groupAccessInput } from '../src/lib/group-access'
import { toolInput } from '../src/lib/mcp/input'
import { MCP_TOOL_REGISTRY } from '../src/lib/mcp/registry'
import { prisma } from '../src/lib/prisma'
import { appRouter } from '../src/trpc/routers/_app'

const db = new URL(process.env.POSTGRES_PRISMA_URL ?? '')
assert(
  ['localhost', '127.0.0.1'].includes(db.hostname) &&
    /test|e2e/.test(db.pathname),
)
const suffix = randomBytes(6).toString('hex')
async function account(name: string) {
  const user = await prisma.user.create({
    data: {
      id: `${name}-${suffix}`,
      name,
      email: `${name}-${suffix}@example.com`,
      emailVerified: true,
    },
  })
  const principal = {
    userId: user.id,
    name: user.name,
    source: 'web' as const,
    connectionId: '',
    groupIds: [] as string[],
  }
  return {
    user,
    principal,
    caller: appRouter.createCaller({ principal, readOnly: true }),
  }
}
const alice = await account('Alice'),
  bob = await account('Bob'),
  eve = await account('Eve')
const form = {
  name: `Identity ${suffix}`,
  currency: '$',
  currencyCode: 'USD',
  participants: [{ name: 'Bob' }, { name: 'Carol' }],
}
const made = await alice.caller.groups.create({ groupFormValues: form })
const groupId = made.groupId
alice.principal.groupIds.push(groupId)
const person = (name: string) =>
  made.group.participants.find((p) => p.name === name)!
let passed = 0
async function check(name: string, f: () => Promise<void>) {
  await f()
  passed++
  console.log(`PASS ${name}`)
}
await check(
  'creator gets one fixed participant automatically, including an otherwise empty group',
  async () => {
    assert.equal(made.group.participants.length, 3)
    assert.equal(
      (await alice.caller.groups.get({ groupId })).membership.participantId,
      person('Alice').id,
    )
    const solo = await alice.caller.groups.create({
      groupFormValues: { ...form, participants: [] },
    })
    assert.equal(solo.group.participants.length, 1)
    const shortName = await account('Q')
    const shortGroup = await shortName.caller.groups.create({
      groupFormValues: { ...form, participants: [] },
    })
    shortName.principal.groupIds.push(shortGroup.groupId)
    await shortName.caller.groups.update({
      groupId: shortGroup.groupId,
      expectedRevision: 1,
      groupFormValues: { name: 'Single character account' },
    })

    await assert.rejects(
      () =>
        alice.caller.groups.create({
          groupFormValues: { ...form, participants: [{ name: 'Alice' }] },
        }),
      /automatically/,
    )
  },
)
let invitation = ''
await check(
  'invite reserves a named participant and accepts only its verified email',
  async () => {
    const result = await alice.caller.groups.access({
      action: 'invite',
      groupId,
      email: bob.user.email,
      participantId: person('Bob').id,
    })
    assert.equal(result.invitation?.participantName, 'Bob')
    invitation = result.invitation!.url
    await assert.rejects(
      () => eve.caller.groups.access({ action: 'join', shareUrl: invitation }),
      /different email/,
    )
    await assert.rejects(
      () =>
        alice.caller.groups.access({
          action: 'invite',
          groupId,
          email: eve.user.email,
          participantId: person('Bob').id,
        }),
      /reserves/,
    )
    await bob.caller.groups.access({ action: 'join', shareUrl: invitation })
    bob.principal.groupIds.push(groupId)
    assert.equal(
      (await bob.caller.groups.get({ groupId })).membership.participantId,
      person('Bob').id,
    )
  },
)
await check(
  'neither admin nor member can switch an already-bound identity',
  async () => {
    await assert.rejects(
      () =>
        alice.caller.groups.access({
          action: 'bind_member',
          groupId,
          userId: bob.user.id,
          email: bob.user.email,
          participantId: person('Carol').id,
        }),
      /already tied/,
    )
    await assert.rejects(
      () =>
        bob.caller.groups.access({
          action: 'bind_member',
          groupId,
          userId: bob.user.id,
          email: bob.user.email,
          participantId: person('Carol').id,
        }),
      /admins/,
    )
    await assert.rejects(
      () =>
        prisma.userGroupAccess.update({
          where: { userId_groupId: { userId: bob.user.id, groupId } },
          data: { participantId: person('Carol').id },
        }),
      /cannot be reassigned/,
    )
  },
)
await check(
  'DB uniqueness rejects a second account claiming the same participant',
  async () => {
    await assert.rejects(
      () =>
        prisma.userGroupAccess.create({
          data: {
            userId: eve.user.id,
            groupId,
            participantId: person('Bob').id,
          },
        }),
      /Unique constraint/,
    )
  },
)
await check(
  'bound participants cannot be renamed or removed through settings',
  async () => {
    await assert.rejects(
      () =>
        alice.caller.groups.update({
          groupId,
          expectedRevision: 1,
          groupFormValues: {
            participants: made.group.participants.map((p) => ({
              id: p.id,
              name: p.name === 'Bob' ? 'Impersonated' : p.name,
            })),
          },
        }),
      /cannot be renamed/,
    )
  },
)
await check(
  'payer and claimed participant never replace the real creator/editor',
  async () => {
    const created = await alice.caller.groups.expenses.create({
      groupId,
      participantId: person('Bob').id,
      expenseFormValues: {
        title: 'Bob paid, Alice recorded',
        amount: '20',
        currencyCode: 'USD',
        expenseDate: new Date('2026-10-01'),
        category: 0,
        paidBy: person('Bob').id,
        paidFor: made.group.participants.map((p) => ({
          participant: p.id,
          shares: '1',
        })),
        splitMode: 'EVENLY',
        isReimbursement: false,
        documents: [],
        notes: '',
        recurrenceRule: 'NONE',
        saveDefaultSplittingOptions: false,
      },
    })
    await bob.caller.groups.expenses.update({
      groupId,
      expenseId: created.expenseId,
      expectedRevision: created.revision,
      expenseFormValues: { title: 'Bob edited' },
      participantId: person('Alice').id,
    })
    const list = await alice.caller.groups.expenses.list({ groupId })
    const row = list.expenses.find((e) => e.id === created.expenseId)!
    assert.equal(row.paidBy.id, person('Bob').id)
    assert.equal(row.attribution?.createdBy?.userId, alice.user.id)
    assert.equal(row.attribution?.updatedBy?.userId, bob.user.id)
    const original = await alice.caller.groups.expenses.get({
      groupId,
      expenseId: created.expenseId,
      revision: 1,
    })
    assert.equal(original.expense.attribution.createdBy?.userId, alice.user.id)
    assert.equal(original.expense.attribution.updatedBy, null)
    const latest = await alice.caller.groups.expenses.get({
      groupId,
      expenseId: created.expenseId,
    })
    assert.equal(latest.expense.attribution.updatedBy?.userId, bob.user.id)

    const balances = await alice.caller.groups.balances.forUser({
      groups: [{ groupId }],
    })
    assert.equal(balances.balances[0].participantId, person('Alice').id)
    assert(Number(balances.balances[0].amount) < 0)
  },
)
await check('leave/rejoin retains the exact identity', async () => {
  await bob.caller.groups.access({ action: 'leave', groupId })
  await assert.rejects(
    () =>
      alice.caller.groups.access({
        action: 'invite',
        groupId,
        email: eve.user.email,
        participantId: person('Bob').id,
      }),
    /already tied/,
  )
  const result = await alice.caller.groups.access({
    action: 'invite',
    groupId,
    email: bob.user.email,
    participantId: person('Bob').id,
  })
  await bob.caller.groups.access({
    action: 'join',
    shareUrl: result.invitation!.url,
  })
  assert.equal(
    (await bob.caller.groups.get({ groupId })).membership.participantId,
    person('Bob').id,
  )
})
const legacy = await createGroup({
  ...form,
  participants: [{ name: 'Legacy Alice' }, { name: 'Legacy Bob' }],
})
await prisma.userGroupAccess.create({
  data: { groupId: legacy.id, userId: alice.user.id, role: 'admin' },
})
alice.principal.groupIds.push(legacy.id)
await check(
  'legacy membership stays unknown until explicit email-checked admin binding',
  async () => {
    assert.deepEqual(
      (
        await alice.caller.groups.balances.forUser({
          groups: [{ groupId: legacy.id }],
        })
      ).unboundGroupIds,
      [legacy.id],
    )
    assert.equal(
      (await alice.caller.groups.get({ groupId: legacy.id })).membership
        .participantId,
      null,
    )
    assert.equal(
      (
        await alice.caller.groups.balances.forUser({
          groups: [{ groupId: legacy.id }],
        })
      ).balances.length,
      0,
    )
    await assert.rejects(
      () =>
        alice.caller.groups.access({
          action: 'bind_member',
          groupId: legacy.id,
          userId: alice.user.id,
          email: bob.user.email,
          participantId: legacy.participants[0].id,
        }),
      /must match/,
    )
    await alice.caller.groups.access({
      action: 'bind_member',
      groupId: legacy.id,
      userId: alice.user.id,
      email: alice.user.email,
      participantId: legacy.participants[0].id,
    })
    assert.equal(
      (await alice.caller.groups.get({ groupId: legacy.id })).membership
        .participantId,
      legacy.participants[0].id,
    )
  },
)
await check(
  'cross-group participant bindings fail even on a direct DB insert',
  async () => {
    await assert.rejects(
      () =>
        prisma.userGroupAccess.create({
          data: {
            groupId: legacy.id,
            userId: eve.user.id,
            participantId: person('Carol').id,
          },
        }),
      /Foreign key/,
    )
  },
)
await check(
  'simultaneous invitations cannot reserve the same participant twice',
  async () => {
    const attempts = await Promise.allSettled(
      [eve.user.email, 'other@example.com'].map((email) =>
        alice.caller.groups.access({
          action: 'invite',
          groupId,
          email,
          participantId: person('Carol').id,
        }),
      ),
    )
    assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1)
  },
)
await check(
  'MCP exposes legitimate invite/bind participantId, not claimed authorship',
  async () => {
    const definition = MCP_TOOL_REGISTRY.find(
      (t) => t.name === 'manage_group_access',
    )!
    assert.equal(
      toolInput(groupAccessInput, definition, true).map({
        action: 'invite',
        groupId,
        email: eve.user.email,
        participantId: person('Carol').id,
      }).participantId,
      person('Carol').id,
    )
  },
)
console.log(`${passed} member identity checks passed`)
await prisma.$disconnect()
