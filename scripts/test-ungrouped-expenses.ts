/** Real database coverage for feed privacy, invitations, ordering and settlement. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { AuditActor } from '../src/lib/expense-history'
import { MCP_OUTPUT_SCHEMAS } from '../src/lib/mcp/output-schemas'
import { prisma } from '../src/lib/prisma'
import { randomId } from '../src/lib/random'
import { appRouter } from '../src/trpc/routers/_app'

const url = new URL(process.env.POSTGRES_PRISMA_URL ?? '')
assert(
  ['localhost', '127.0.0.1'].includes(url.hostname) &&
    /test|e2e/.test(url.pathname),
  'Use a disposable local database',
)
const suffix = randomBytes(5).toString('hex')
let checks = 0
async function check({
  name,
  run,
}: {
  name: string
  run: () => Promise<void>
}) {
  await run()
  checks++
  console.log(`PASS ${name}`)
}
async function account({ name }: { name: string }) {
  const user = await prisma.user.create({
    data: {
      id: `${name}-${suffix}`,
      name,
      email: `${name}-${suffix}@example.com`,
      emailVerified: true,
    },
  })
  const principal: AuditActor & { groupIds: string[] } = {
    userId: user.id,
    name,
    source: 'web',
    connectionId: '',
    groupIds: [],
  }
  return {
    user,
    principal,
    caller: appRouter.createCaller({ principal, readOnly: true }),
  }
}
const alice = await account({ name: 'Alice' }),
  bob = await account({ name: 'Bob' }),
  carol = await account({ name: 'Carol' }),
  outsider = await account({ name: 'Outsider' }),
  guest = await account({ name: 'Guest' })
const group = await alice.caller.groups.create({
  groupFormValues: {
    name: `Household ${suffix}`,
    currency: '$',
    currencyCode: 'USD',
    participants: [{ name: 'Bob' }, { name: 'Carol' }],
  },
})
alice.principal.groupIds.push(group.groupId)
for (const peer of [bob, carol]) {
  const participant = group.group.participants.find(
    (p) => p.name === peer.user.name,
  )!
  const invite = await alice.caller.groups.access({
    action: 'invite',
    groupId: group.groupId,
    email: peer.user.email,
    participantId: participant.id,
  })
  await peer.caller.groups.access({
    action: 'join',
    shareUrl: invite.invitation!.url,
  })
  peer.principal.groupIds.push(group.groupId)
}
const aliceParticipant = group.group.participants.find(
  (p) => p.name === 'Alice',
)!
const bobParticipant = group.group.participants.find((p) => p.name === 'Bob')!
const basic = {
  title: 'Shared meal',
  amount: '60',
  currencyCode: 'USD' as const,
  expenseDate: '2026-10-09',
  isReimbursement: false,
}
const excluded = await bob.caller.groups.expenses.create({
  groupId: group.groupId,
  expenseFormValues: {
    ...basic,
    title: 'Only Bob',
    paidBy: bobParticipant.id,
    paidFor: [{ participant: bobParticipant.id, shares: '1' }],
  },
})
const included = await alice.caller.groups.expenses.create({
  groupId: group.groupId,
  expenseFormValues: {
    ...basic,
    title: 'Household supplies',
    paidBy: aliceParticipant.id,
    paidFor: group.group.participants.map((p) => ({
      participant: p.id,
      shares: '1',
    })),
  },
})
const privateId = randomId()
const people = [
  { kind: 'account' as const, id: randomId(), userId: alice.user.id },
  { kind: 'account' as const, id: randomId(), userId: bob.user.id },
]
const savedPrivate = await alice.caller.expenses.createUngrouped({
  expenseId: privateId,
  people,
  expense: {
    ...basic,
    title: 'Private dinner',
    paidBy: people[0]!.id,
    paidFor: people.map((p) => ({ participant: p.id, shares: '1' })),
  },
})
const savedPeople = people.map((p) => ({
  ...p,
  id: savedPrivate.participants.find((stored) => stored.localId === p.id)!
    .participantId,
}))
alice.principal.groupIds.push(privateId)
bob.principal.groupIds.push(privateId)

await check({
  name: 'involving-me is based on participation, with all-accessible opt-in',
  run: async () => {
    const mine = await alice.caller.expenses.list({ involvingMe: true })
    assert(mine.expenses.some((e) => e.id === included.expenseId))
    assert(mine.expenses.some((e) => e.id === privateId && e.group === null))
    assert(!mine.expenses.some((e) => e.id === excluded.expenseId))
    assert(
      (await alice.caller.expenses.list({ involvingMe: false })).expenses.some(
        (e) => e.id === excluded.expenseId,
      ),
    )
    MCP_OUTPUT_SCHEMAS['expenses.list'].parse(JSON.parse(JSON.stringify(mine)))
  },
})
await check({
  name: 'private expense is visible to participants and absent from named groups',
  run: async () => {
    assert(
      (await bob.caller.expenses.list({})).expenses.some(
        (e) => e.id === privateId,
      ),
    )
    assert(
      !(await carol.caller.expenses.list({})).expenses.some(
        (e) => e.id === privateId,
      ),
    )
    assert(
      !(await alice.caller.groups.list({})).groups.some(
        (g) => g.id === privateId,
      ),
    )
  },
})
await check({
  name: 'non-participants cannot bypass privacy using IDs, filters or history',
  run: async () => {
    for (const peer of [carol, outsider]) {
      assert.equal(
        (await peer.caller.expenses.list({ groupId: privateId })).expenses
          .length,
        0,
      )
      await assert.rejects(
        () => peer.caller.expenses.context({ expenseId: privateId }),
        /not found/,
      )
      await assert.rejects(
        () =>
          peer.caller.groups.expenses.get({
            groupId: privateId,
            expenseId: privateId,
          }),
        /access denied/i,
      )
      await assert.rejects(
        () => peer.caller.groups.activities.list({ groupId: privateId }),
        /access denied/i,
      )
    }
  },
})
await check({
  name: 'named group and no-group filters run before pagination',
  run: async () => {
    assert(
      (await alice.caller.expenses.list({ scope: 'ungrouped' })).expenses.every(
        (e) => e.group === null,
      ),
    )
    assert(
      (await alice.caller.expenses.list({ scope: 'grouped' })).expenses.every(
        (e) => e.group !== null,
      ),
    )
    assert(
      (
        await alice.caller.expenses.list({ groupId: group.groupId })
      ).expenses.every((e) => e.group?.id === group.groupId),
    )
    const narrow = await alice.caller.expenses.list({
      filter: 'Private dinner',
      limit: 1,
      paidByUserId: alice.user.id,
      personId: bob.user.id,
      from: '2026-10-09',
      to: '2026-10-09',
      currencyCode: 'USD',
    })
    assert.deepEqual(
      narrow.expenses.map((e) => e.id),
      [privateId],
    )
    await assert.rejects(
      () =>
        alice.caller.expenses.list({ from: '2026-10-10', to: '2026-10-09' }),
      /start date/,
    )
  },
})
await check({
  name: 'stable newest-first pagination survives a new expense at the head',
  run: async () => {
    const all = await alice.caller.expenses.list({ limit: 100 })
    const first = await alice.caller.expenses.list({ limit: 1 })
    assert(first.nextCursor)
    await alice.caller.groups.expenses.create({
      groupId: group.groupId,
      expenseFormValues: {
        ...basic,
        expenseDate: '2026-10-10',
        title: 'New head',
        paidBy: aliceParticipant.id,
        paidFor: [{ participant: aliceParticipant.id, shares: '1' }],
      },
    })
    const next = await alice.caller.expenses.list({
      cursor: first.nextCursor,
      limit: 100,
    })
    assert.deepEqual(
      [first.expenses[0]!.id, ...next.expenses.map((e) => e.id)],
      all.expenses.map((e) => e.id),
    )
    assert.equal(
      (await alice.caller.expenses.list({ limit: 1 })).expenses[0]!.title,
      'New head',
    )
  },
})
await check({
  name: 'private access cannot be expanded or reclassified by group tools',
  run: async () => {
    await assert.rejects(
      () =>
        alice.caller.groups.update({
          groupId: privateId,
          expectedRevision: 1,
          groupFormValues: { name: 'Public household' },
        }),
      /private expense/i,
    )
    await assert.rejects(
      () =>
        alice.caller.groups.access({
          action: 'invite',
          groupId: privateId,
          participantId: savedPeople[1]!.id,
          email: outsider.user.email,
        }),
      /original people/,
    )
    await assert.rejects(
      () =>
        alice.caller.groups.expenses.create({
          groupId: privateId,
          expenseFormValues: {
            ...basic,
            paidBy: savedPeople[0]!.id,
            paidFor: savedPeople.map((p) => ({
              participant: p.id,
              shares: '1',
            })),
          },
        }),
      /separate ungrouped/,
    )
  },
})
await check({
  name: 'private editing preserves roster, exact money and revisions',
  run: async () => {
    await assert.rejects(
      () =>
        alice.caller.groups.expenses.update({
          groupId: privateId,
          expenseId: privateId,
          expectedRevision: 1,
          expenseFormValues: {
            paidFor: [{ participant: savedPeople[0]!.id, shares: '1' }],
          },
        }),
      /people with access/,
    )
    const result = await bob.caller.groups.expenses.update({
      groupId: privateId,
      expenseId: privateId,
      expectedRevision: 1,
      expenseFormValues: { title: 'Private dinner corrected' },
    })
    assert.equal(result.revision, 2)
    await assert.rejects(
      () =>
        alice.caller.groups.expenses.update({
          groupId: privateId,
          expenseId: privateId,
          expectedRevision: 1,
          expenseFormValues: { title: 'Stale edit' },
        }),
      /changed|revision|conflict/i,
    )
  },
})
await check({
  name: 'repayment settles only the selected expense, preserving household balances',
  run: async () => {
    const householdBefore = await alice.caller.groups.balances.list({
      groupId: group.groupId,
    })
    await bob.caller.groups.expenses.create({
      groupId: privateId,
      expenseFormValues: {
        ...basic,
        title: 'Payment',
        amount: '30',
        isReimbursement: true,
        paidBy: savedPeople[1]!.id,
        paidFor: [{ participant: savedPeople[0]!.id, shares: '1' }],
      },
    })
    assert.equal(
      (await alice.caller.groups.balances.list({ groupId: privateId }))
        .currencies[0]!.reimbursements.length,
      0,
    )
    assert.deepEqual(
      await alice.caller.groups.balances.list({ groupId: group.groupId }),
      householdBefore,
    )
    await assert.rejects(
      () =>
        alice.caller.groups.expenses.delete({
          groupId: privateId,
          expenseId: privateId,
          expectedRevision: 2,
        }),
      /recorded repayments/,
    )
  },
})
await check({
  name: 'three-person ad hoc expense and email invitation are private and atomic',
  run: async () => {
    const id = randomId()
    const third = {
      kind: 'email' as const,
      id: randomId(),
      email: guest.user.email,
      name: 'Guest',
    }
    const roster = [...people.map((p) => ({ ...p, id: randomId() })), third]
    const result = await alice.caller.expenses.createUngrouped({
      expenseId: id,
      people: roster,
      expense: {
        ...basic,
        title: 'Ad hoc three-person dinner',
        paidBy: roster[0]!.id,
        paidFor: roster.map((p) => ({ participant: p.id, shares: '1' })),
      },
    })
    assert.equal(result.invitations.length, 1)
    await prisma.groupInvitation.updateMany({
      where: { groupId: id },
      data: { expiresAt: new Date(0) },
    })
    assert.equal(
      (await alice.caller.groups.getDetails({ groupId: id })).access.invitations
        .length,
      1,
    )
    await assert.rejects(
      () =>
        outsider.caller.expenses.renewInvitation({
          groupId: id,
          participantId: result.participants.find(
            (p) => p.localId === third.id,
          )!.participantId,
        }),
      /access/i,
    )
    const renewed = await alice.caller.expenses.renewInvitation({
      groupId: id,
      participantId: result.participants.find((p) => p.localId === third.id)!
        .participantId,
    })
    await assert.rejects(
      () =>
        guest.caller.groups.access({
          action: 'join',
          shareUrl: result.invitations[0]!.url,
        }),
      /expired|revoked|different email/,
    )
    await assert.rejects(
      () => guest.caller.expenses.context({ expenseId: id }),
      /not found/,
    )
    await assert.rejects(
      () =>
        outsider.caller.groups.access({
          action: 'join',
          shareUrl: result.invitations[0]!.url,
        }),
      /different email/,
    )
    await guest.caller.groups.access({
      action: 'join',
      shareUrl: renewed.url,
    })
    assert(
      (await guest.caller.expenses.list({})).expenses.some((e) => e.id === id),
    )
    const count = await prisma.expense.count()
    await assert.rejects(
      () =>
        alice.caller.expenses.createUngrouped({
          expenseId: id,
          people: roster,
          expense: {
            ...basic,
            paidBy: roster[0]!.id,
            paidFor: roster.map((p) => ({ participant: p.id, shares: '1' })),
          },
        }),
      /already exists/,
    )
    assert.equal(await prisma.expense.count(), count)
  },
})
await check({
  name: 'forged account IDs and uninvolved extra viewers are rejected',
  run: async () => {
    const forged = [
      ...people,
      { kind: 'account' as const, id: randomId(), userId: outsider.user.id },
    ]
    await assert.rejects(
      () =>
        alice.caller.expenses.createUngrouped({
          expenseId: randomId(),
          people: forged,
          expense: {
            ...basic,
            paidBy: people[0]!.id,
            paidFor: forged.map((p) => ({ participant: p.id, shares: '1' })),
          },
        }),
      /existing contact/,
    )
    await assert.rejects(
      () =>
        alice.caller.expenses.createUngrouped({
          expenseId: randomId(),
          people,
          expense: {
            ...basic,
            paidBy: people[0]!.id,
            paidFor: [{ participant: people[0]!.id, shares: '1' }],
          },
        }),
      /exactly the people/,
    )
  },
})
await check({
  name: 'contact lookup exposes only shared verified members and self',
  run: async () => {
    const options = await outsider.caller.expenses.options()
    assert.deepEqual(
      options.people.map((p) => p.id),
      [outsider.user.id],
    )
    MCP_OUTPUT_SCHEMAS['expenses.options'].parse(options)
  },
})
console.log(`${checks} integration scenarios passed`)
await prisma.$disconnect()
