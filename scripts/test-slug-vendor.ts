import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { createRecurringExpenses } from '../src/lib/api'
import { expenseSnapshotSchema } from '../src/lib/expense-history'
import { MCP_OUTPUT_SCHEMAS } from '../src/lib/mcp/output-schemas'
import { prisma } from '../src/lib/prisma'
import { randomId } from '../src/lib/random'
import { appRouter } from '../src/trpc/routers/_app'
import { seedTestAgent } from './auth-test-utils'

const database = new URL(process.env.POSTGRES_PRISMA_URL ?? '')
assert(
  ['localhost', '127.0.0.1'].includes(database.hostname) &&
    database.pathname.endsWith('_audit_test'),
)
const suffix = randomBytes(6).toString('hex')
const userId = `slug-vendor-${suffix}`

async function main() {
  const keyId = await seedTestAgent(userId, randomBytes(32).toString('hex'))
  const principal = {
    userId,
    name: 'Test owner',
    connectionId: keyId,
    source: 'agent' as const,
    groupIds: [] as string[],
  }
  const caller = appRouter.createCaller({ principal, readOnly: true })
  const values = {
    name: 'Slug and vendor checks',
    currency: '$',
    currencyCode: 'USD',
    participants: [{ name: 'Housemate' }],
  }
  const slug = `house-${suffix}`
  const created = await caller.groups.create({
    groupFormValues: { ...values, slug: ` ${slug.toUpperCase()} ` },
  })
  const groupId = created.groupId
  principal.groupIds.push(groupId)
  assert.equal(created.group.slug, slug)
  let group = created.group
  const details = await caller.groups.getDetails({ groupId })
  assert(details.links.share.endsWith(`/${slug}`))
  MCP_OUTPUT_SCHEMAS['groups.getDetails'].parse(
    JSON.parse(JSON.stringify(details)),
  )
  const rename = await caller.groups.update({
    groupId,
    expectedRevision: group.revision,
    groupFormValues: { name: 'Renamed house' },
  })
  group = rename.group
  assert.equal(group.slug, slug)
  await assert.rejects(
    caller.groups.update({
      groupId,
      expectedRevision: 0,
      groupFormValues: { slug: 'another-house' },
    }),
    /revision|changed/i,
  )
  await assert.rejects(
    caller.groups.create({ groupFormValues: { ...values, slug } }),
    /already in use/,
  )
  await assert.rejects(
    caller.groups.update({
      groupId,
      expectedRevision: group.revision,
      groupFormValues: { slug: 'api' },
    }),
    /reserved/,
  )
  const raceSlug = `race-${suffix}`
  const race = await Promise.allSettled(
    [1, 2].map(() =>
      caller.groups.create({ groupFormValues: { ...values, slug: raceSlug } }),
    ),
  )
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(race.filter((result) => result.status === 'rejected').length, 1)
  console.log(
    'PASS slug normalization, links, revisions, reserved routes and concurrent uniqueness',
  )

  const [owner, housemate] = group.participants
  assert(owner && housemate)
  const expense = {
    title: 'hangers and sponges',
    vendor: ' Costco ',
    amount: '30',
    currencyCode: 'USD' as const,
    expenseDate: '2026-09-18',
    paidBy: owner.id,
    paidFor: group.participants.map((person) => ({
      participant: person.id,
      shares: '1',
    })),
    splitMode: 'EVENLY' as const,
    isReimbursement: false,
  }
  const saved = await caller.groups.expenses.create({
    groupId,
    expenseId: randomId(),
    expenseFormValues: expense,
  })
  const expenseId = saved.expenseId
  const read = await caller.groups.expenses.get({ groupId, expenseId })
  assert.equal(read.expense.vendor, 'Costco')
  assert.equal(read.expense.title, expense.title)
  MCP_OUTPUT_SCHEMAS['groups.expenses.get'].parse(
    JSON.parse(JSON.stringify(read)),
  )
  const snapshot = (
    await caller.groups.expenses.get({ groupId, expenseId, revision: 1 })
  ).history!.snapshot
  assert.equal(snapshot.expense.vendor, 'Costco')
  const legacy = structuredClone(snapshot)
  delete legacy.expense.vendor
  delete legacy.group.slug
  assert.equal(expenseSnapshotSchema.parse(legacy).expense.vendor, undefined)
  for (const query of [
    {},
    {
      atActivityId: (
        await caller.groups.activities.list({ groupId, expenseId })
      ).atActivityId!,
    },
  ]) {
    const found = await caller.groups.expenses.list({
      groupId,
      filter: 'costco',
      vendor: 'COSTCO',
      participantId: housemate.id,
      from: '2026-09-18',
      to: '2026-09-18',
      ...query,
    })
    assert.equal(found.expenses[0]?.id, expenseId)
    MCP_OUTPUT_SCHEMAS['groups.expenses.list'].parse(
      JSON.parse(JSON.stringify(found)),
    )
    assert.equal(
      (
        await caller.groups.expenses.list({
          groupId,
          vendor: 'Amazon',
          ...query,
        })
      ).expenses.length,
      0,
    )
  }
  const changed = await caller.groups.expenses.update({
    groupId,
    expenseId,
    expectedRevision: read.expense.revision,
    expenseFormValues: { notes: 'Keep vendor' },
  })
  assert.equal(
    (await caller.groups.expenses.get({ groupId, expenseId })).expense.vendor,
    'Costco',
  )
  await caller.groups.expenses.update({
    groupId,
    expenseId,
    expectedRevision: changed.revision,
    expenseFormValues: { vendor: '' },
  })
  assert.equal(
    (await caller.groups.expenses.get({ groupId, expenseId })).expense.vendor,
    null,
  )
  assert.equal(
    (await caller.groups.expenses.get({ groupId, expenseId, revision: 1 }))
      .expense.vendor,
    'Costco',
  )
  console.log(
    'PASS vendor create, partial edit, clear, history, legacy snapshots and combined search filters',
  )

  const recurrence = await caller.groups.expenses.create({
    groupId,
    expenseId: randomId(),
    expenseFormValues: {
      ...expense,
      vendor: '=Costco',
      recurrenceRule: 'DAILY',
      expenseDate: new Date(Date.now() - 2 * 86400000)
        .toISOString()
        .slice(0, 10),
    },
  })
  const due = await createRecurringExpenses(groupId, principal)
  assert(due.createdExpenseIds.length > 0)
  for (const id of due.createdExpenseIds)
    assert.equal(
      (await caller.groups.expenses.get({ groupId, expenseId: id })).expense
        .vendor,
      '=Costco',
    )
  const csv = await caller.groups.export({ groupId, format: 'csv' })
  assert(csv.content.includes('"Vendor"'))
  assert(csv.content.includes("'=Costco"))
  const json = z
    .object({
      slug: z.string().nullable(),
      expenses: z.array(
        z.object({ id: z.string(), vendor: z.string().nullable() }),
      ),
    })
    .parse(
      JSON.parse(
        (await caller.groups.export({ groupId, format: 'json' })).content,
      ),
    )
  assert.equal(json.slug, slug)
  assert.equal(
    json.expenses.find(
      (entry: { id: string }) => entry.id === recurrence.expenseId,
    )?.vendor,
    '=Costco',
  )
  console.log('PASS recurrence and CSV/JSON export including formula escaping')

  await prisma.userGroupAccess.update({
    where: { userId_groupId: { userId, groupId } },
    data: { role: 'member' },
  })
  await assert.rejects(
    caller.groups.update({
      groupId,
      expectedRevision: group.revision,
      groupFormValues: { slug: 'forbidden-house' },
    }),
    /admins/,
  )
  await prisma.userGroupAccess.update({
    where: { userId_groupId: { userId, groupId } },
    data: { role: 'admin' },
  })
  const cleared = await caller.groups.update({
    groupId,
    expectedRevision: group.revision,
    groupFormValues: { slug: null },
  })
  assert.equal(cleared.group.id, groupId)
  assert.equal(cleared.group.slug, null)
  assert.equal(
    (await caller.groups.expenses.get({ groupId, expenseId })).expense.amount,
    '30',
  )
  console.log(
    'PASS admin-only settings and removing slug preserves stable ID and expenses',
  )
}

main().finally(() => prisma.$disconnect())
