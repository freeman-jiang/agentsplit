import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { CallToolResultSchema } from '@modelcontextprotocol/core'
import { Client } from 'pg'
import * as z from 'zod'
import {
  createExpense,
  createGroup,
  deleteExpense,
  getActiveRecurringExpenses,
  getActivities,
  getExpense,
  getGroup,
  getGroupExpenses,
  updateExpense,
  updateGroup,
} from '../src/lib/api'
import { expenseSnapshotSchema } from '../src/lib/expense-history'
import { describeExpenseRevision } from '../src/lib/expense-history-display'
import { hashAccessKey } from '../src/lib/mcp/access'
import { prisma } from '../src/lib/prisma'
import { expenseFormSchema } from '../src/lib/schemas'

// Never run mutation integration tests against the deployed application database.
const database = new URL(process.env.POSTGRES_PRISMA_URL ?? '')
assert(
  ['127.0.0.1', 'localhost'].includes(database.hostname) &&
    database.pathname.endsWith('_audit_test'),
  'Use a dedicated loopback database whose name ends in _audit_test',
)
const passed: string[] = []
async function check(name: string, run: () => Promise<void>) {
  await run()
  passed.push(name)
  console.log(`PASS ${name}`)
}
const groupValues = {
  name: 'Audit integration test',
  currency: '$',
  currencyCode: 'USD',
  participants: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }],
}

try {
  if (process.env.AGENTSPLIT_AUDIT_UPGRADE_TEST === '1') {
    const client = new Client({ connectionString: database.href })
    await client.connect()
    try {
      const empty = await client.query(
        'SELECT to_regclass(\'public."Expense"\') AS existing',
      )
      assert.equal(
        empty.rows[0].existing,
        null,
        'Upgrade test requires an empty disposable database',
      )
      const migrations = (await readdir('prisma/migrations'))
        .filter((name) => /^\d/.test(name))
        .sort()
      for (const migration of migrations.filter(
        (name) => !name.endsWith('preserve_expense_revisions'),
      ))
        await client.query(
          await readFile(
            `prisma/migrations/${migration}/migration.sql`,
            'utf8',
          ),
        )
      await client.query(
        `INSERT INTO "Group" ("id", "name", "currency", "currencyCode") VALUES ('upgrade-group', 'Upgrade group', '$', 'USD')`,
      )
      await client.query(
        `INSERT INTO "Participant" ("id", "name", "groupId") VALUES ('upgrade-alice', 'Alice', 'upgrade-group'), ('upgrade-bob', 'Bob', 'upgrade-group')`,
      )
      await client.query(
        `INSERT INTO "Expense" ("id", "groupId", "title", "amount", "paidById", "notes") VALUES ('upgrade-expense', 'upgrade-group', 'Pre-migration dinner', 4500, 'upgrade-alice', 'Pre-migration notes')`,
      )
      await client.query(
        `INSERT INTO "ExpensePaidFor" ("expenseId", "participantId", "shares") VALUES ('upgrade-expense', 'upgrade-alice', 1), ('upgrade-expense', 'upgrade-bob', 1)`,
      )
      await client.query(
        `INSERT INTO "ExpenseDocument" ("id", "expenseId", "url", "width", "height") VALUES ('upgrade-receipt', 'upgrade-expense', 'https://example.invalid/pre-migration.png', 100, 100)`,
      )
      await client.query(
        `INSERT INTO "Activity" ("id", "groupId", "activityType", "expenseId", "data") VALUES ('upgrade-event', 'upgrade-group', 'CREATE_EXPENSE', 'upgrade-expense', 'Legacy summary')`,
      )
      await client.query(
        await readFile(
          'prisma/migrations/20260930220000_preserve_expense_revisions/migration.sql',
          'utf8',
        ),
      )
    } finally {
      await client.end()
    }
    await check(
      'migration preserves existing records and captures their baseline before deletion',
      async () => {
        const old = await getExpense('upgrade-group', 'upgrade-expense')
        assert.equal(old?.amount, 4500)
        assert.equal(
          old?.documents[0].url,
          'https://example.invalid/pre-migration.png',
        )
        assert.equal(
          (
            await prisma.activity.findUniqueOrThrow({
              where: { id: 'upgrade-event' },
            })
          ).snapshot,
          null,
        )
        await deleteExpense('upgrade-group', 'upgrade-expense')
        const baseline = await prisma.activity.findUniqueOrThrow({
          where: {
            expenseId_expenseRevision: {
              expenseId: 'upgrade-expense',
              expenseRevision: 0,
            },
          },
        })
        const snapshot = expenseSnapshotSchema.parse(baseline.snapshot)
        assert.equal(snapshot.expense.amount, 4500)
        assert.equal(snapshot.expense.notes, 'Pre-migration notes')
        assert.deepEqual(
          (
            await getActivities('upgrade-group', {
              expenseId: 'upgrade-expense',
            })
          ).map((event) => event.expenseRevision),
          [1, 0, null],
        )
        assert.equal(
          snapshot.expense.documents[0].url,
          'https://example.invalid/pre-migration.png',
        )
      },
    )
  }
  const group = await createGroup(groupValues)
  const [alice, bob, carol] = group.participants
  assert(alice && bob && carol)
  const form = expenseFormSchema.parse({
    title: 'Original dinner',
    amount: 6000,
    expenseDate: new Date('2026-09-30T00:00:00Z'),
    category: 0,
    paidBy: alice.id,
    paidFor: [alice, bob, carol].map((person) => ({
      participant: person.id,
      shares: 1,
    })),
    splitMode: 'EVENLY',
    isReimbursement: false,
    saveDefaultSplittingOptions: false,
    originalCurrency: null,
    documents: [
      {
        id: 'synthetic-receipt',
        url: 'https://example.invalid/receipt.png',
        width: 100,
        height: 100,
      },
    ],
    notes: 'Original notes',
    recurrenceRule: 'NONE',
  })
  const expense = await createExpense(form, group.id, alice.id)
  await check(
    'creation records a full revision with receipt pointers and an unverified actor label',
    async () => {
      const history = await getActivities(group.id, { expenseId: expense.id })
      assert.equal(history.length, 1)
      const snapshot = expenseSnapshotSchema.parse(history[0].snapshot)
      assert.equal(snapshot.expense.revision, 1)
      assert.equal(snapshot.expense.amount, 6000)
      assert.equal(snapshot.expense.documents[0].url, form.documents[0].url)
      assert.equal(snapshot.expense.paidBy.name, 'Alice')
      assert.equal(history[0].actorName, 'Alice')
      assert.equal(history[0].actorUserId, null)
      assert.equal(history[0].source, 'web')
    },
  )
  const revised = {
    ...form,
    amount: 9000,
    splitMode: 'BY_SHARES' as const,
    paidFor: [
      { participant: alice.id, shares: 1 },
      { participant: bob.id, shares: 3 },
      { participant: carol.id, shares: 2 },
    ],
    title: 'Updated dinner',
    notes: 'Updated notes',
  }
  await updateExpense(group.id, expense.id, revised, bob.id)
  await check(
    'split edits preserve the old revision and display exact previous/current allocations',
    async () => {
      const history = await getActivities(group.id, { expenseId: expense.id })
      assert.deepEqual(
        history.map((event) => event.expenseRevision),
        [2, 1],
      )
      const old = expenseSnapshotSchema.parse(history[1].snapshot)
      const current = expenseSnapshotSchema.parse(history[0].snapshot)
      assert.equal(old.expense.title, 'Original dinner')
      assert.equal(old.expense.amount, 6000)
      assert.deepEqual(
        old.expense.paidFor.map((person) => person.shares),
        [1, 1, 1],
      )
      assert.equal(current.expense.splitMode, 'BY_SHARES')
      assert.equal(
        current.expense.documents[0].url,
        old.expense.documents[0].url,
      )
      assert.match(
        describeExpenseRevision(old, 'en-US').splits,
        /Bob: 20\.00 USD/,
      )
      assert.match(
        describeExpenseRevision(current, 'en-US').splits,
        /Bob: 45\.00 USD/,
      )
      assert.deepEqual(history[0].previousSnapshot, old)
    },
  )
  await check(
    'a failed activity insert rolls back the expense, shares, and revision together',
    async () => {
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION agentsplit_test_reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional audit test failure'; END; $$`,
      )
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER agentsplit_test_reject_event BEFORE INSERT ON "Activity" FOR EACH ROW WHEN (NEW."data" = 'reject-revision-test') EXECUTE FUNCTION agentsplit_test_reject_event()`,
      )
      try {
        const before = await getExpense(group.id, expense.id)
        const count = await prisma.activity.count({
          where: { groupId: group.id },
        })
        await assert.rejects(
          updateExpense(group.id, expense.id, {
            ...revised,
            title: 'reject-revision-test',
            amount: 12345,
          }),
        )
        assert.deepEqual(await getExpense(group.id, expense.id), before)
        assert.equal(
          await prisma.activity.count({ where: { groupId: group.id } }),
          count,
        )
      } finally {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER agentsplit_test_reject_event ON "Activity"',
        )
        await prisma.$executeRawUnsafe(
          'DROP FUNCTION agentsplit_test_reject_event()',
        )
      }
    },
  )
  await deleteExpense(group.id, expense.id, bob.id)
  await check(
    'deletion hides current expenses and balances but retains the row and historical receipt/splits',
    async () => {
      assert.equal(await getExpense(group.id, expense.id), null)
      assert.equal(
        (await getGroupExpenses(group.id, { readOnly: true })).length,
        0,
      )
      const retained = await prisma.expense.findUniqueOrThrow({
        where: { id: expense.id },
      })
      assert(retained.deletedAt)
      const history = await getActivities(group.id, { expenseId: expense.id })
      assert.deepEqual(
        history.map((event) => event.expenseRevision),
        [3, 2, 1],
      )
      assert.equal(history[0].snapshot, null)
      assert.equal(history[0].expense, undefined)
      assert.equal(
        expenseSnapshotSchema.parse(history[0].previousSnapshot).expense
          .documents[0].url,
        form.documents[0].url,
      )
    },
  )
  await check(
    'history update/delete/truncate and hard expense deletion are blocked by PostgreSQL',
    async () => {
      const event = await prisma.activity.findFirstOrThrow({
        where: { expenseId: expense.id },
      })
      await assert.rejects(
        prisma.activity.update({
          where: { id: event.id },
          data: { data: 'forged' },
        }),
      )
      await assert.rejects(prisma.activity.delete({ where: { id: event.id } }))
      await assert.rejects(prisma.$executeRawUnsafe('TRUNCATE "Activity"'))
      await assert.rejects(prisma.expense.delete({ where: { id: expense.id } }))
      await assert.rejects(
        prisma.$executeRawUnsafe('TRUNCATE "Expense" CASCADE'),
      )
      assert.equal(
        (await prisma.activity.findUniqueOrThrow({ where: { id: event.id } }))
          .data,
        event.data,
      )
    },
  )
  await check(
    'participant removal cannot cascade away a deleted expense or its history',
    async () => {
      await assert.rejects(
        updateGroup(group.id, {
          ...groupValues,
          participants: group.participants.filter(
            (person) => person.id !== alice.id,
          ),
        }),
      )
      assert(await prisma.expense.findUnique({ where: { id: expense.id } }))
      assert.equal((await getGroup(group.id))?.participants.length, 3)
    },
  )
  await check(
    'renaming participants/currency does not rewrite past snapshots',
    async () => {
      await updateGroup(
        group.id,
        {
          ...groupValues,
          currency: '€',
          currencyCode: 'EUR',
          participants: group.participants.map((person) => ({
            id: person.id,
            name: person.id === alice.id ? 'Alicia' : person.name,
          })),
        },
        alice.id,
      )
      const initial = await prisma.activity.findUniqueOrThrow({
        where: {
          expenseId_expenseRevision: {
            expenseId: expense.id,
            expenseRevision: 1,
          },
        },
      })
      const snapshot = expenseSnapshotSchema.parse(initial.snapshot)
      assert.equal(snapshot.expense.paidBy.name, 'Alice')
      assert.equal(snapshot.group.currencyCode, 'USD')
    },
  )
  const legacy = await prisma.expense.create({
    data: {
      id: `legacy-${Date.now()}`,
      groupId: group.id,
      title: 'Legacy expense',
      amount: 3000,
      paidById: alice.id,
      categoryId: 0,
      paidFor: { create: { participantId: bob.id, shares: 1 } },
    },
  })
  await check(
    'legacy expenses receive a baseline before the first edit',
    async () => {
      await updateExpense(group.id, legacy.id, { ...form, amount: 4000 })
      const history = await getActivities(group.id, { expenseId: legacy.id })
      assert.deepEqual(
        history.map((event) => event.expenseRevision),
        [1, 0],
      )
      assert.equal(history[1].source, 'baseline')
      assert.equal(
        expenseSnapshotSchema.parse(history[1].snapshot).expense.amount,
        3000,
      )
    },
  )
  await check(
    'expense changes without a corresponding event cannot commit',
    async () => {
      const before = await getExpense(group.id, legacy.id)
      await assert.rejects(
        prisma.expense.update({
          where: { id: legacy.id },
          data: { amount: 5555 },
        }),
      )
      await assert.rejects(
        prisma.expense.update({
          where: { id: legacy.id },
          data: { amount: 5555, revision: { increment: 1 } },
        }),
      )
      assert.deepEqual(await getExpense(group.id, legacy.id), before)
    },
  )
  await check(
    'concurrent updates serialize into two complete, ordered revisions',
    async () => {
      await Promise.all([
        updateExpense(group.id, legacy.id, { ...form, amount: 7000 }),
        updateExpense(group.id, legacy.id, { ...form, amount: 8000 }),
      ])
      const history = await getActivities(group.id, { expenseId: legacy.id })
      assert.deepEqual(
        history.map((event) => event.expenseRevision),
        [3, 2, 1, 0],
      )
      const latest = expenseSnapshotSchema.parse(history[0].snapshot)
      assert.equal(
        latest.expense.amount,
        (await getExpense(group.id, legacy.id))?.amount,
      )
      assert.deepEqual(
        new Set(
          history
            .slice(0, 2)
            .map(
              (event) =>
                expenseSnapshotSchema.parse(event.snapshot).expense.amount,
            ),
        ),
        new Set([7000, 8000]),
      )
    },
  )
  const other = await createGroup({ ...groupValues, name: 'Other audit group' })
  await check(
    'foreign-group deletes and history queries cannot affect or expose another expense',
    async () => {
      await assert.rejects(deleteExpense(other.id, legacy.id))
      assert(await getExpense(group.id, legacy.id))
      assert.deepEqual(
        await getActivities(other.id, { expenseId: legacy.id }),
        [],
      )
    },
  )
  await check(
    'history supports filtered pagination with predecessors outside the current page',
    async () => {
      const first = await getActivities(group.id, {
        expenseId: legacy.id,
        offset: 0,
        length: 1,
      })
      const second = await getActivities(group.id, {
        expenseId: legacy.id,
        offset: 1,
        length: 1,
      })
      assert.equal(first[0].expenseRevision, 3)
      assert.equal(second[0].expenseRevision, 2)
      assert.equal(
        expenseSnapshotSchema.parse(first[0].previousSnapshot).expense.revision,
        2,
      )
      assert.equal(
        (
          await getActivities(group.id, {
            expenseId: legacy.id,
            activityType: 'UPDATE_EXPENSE',
          })
        ).length,
        3,
      )
      assert.deepEqual(await getActivities(group.id, { to: '2000-01-01' }), [])
    },
  )
  await check(
    'recurring creation records snapshots and copies receipt pointers without moving old documents',
    async () => {
      const current = await getGroup(group.id)
      assert(current)
      const date = new Date()
      date.setUTCDate(date.getUTCDate() - 2)
      date.setUTCHours(0, 0, 0, 0)
      const recurring = await createExpense(
        {
          ...form,
          title: 'Daily recurring test',
          expenseDate: date,
          recurrenceRule: 'DAILY',
        },
        group.id,
      )
      await getGroupExpenses(group.id)
      const system = await prisma.activity.findMany({
        where: { groupId: group.id, source: 'system' },
      })
      assert.equal(system.length, 2)
      assert.equal(
        (await getExpense(group.id, recurring.id))?.documents.length,
        1,
      )
      for (const event of system)
        assert.equal(
          expenseSnapshotSchema.parse(event.snapshot).expense.documents[0].url,
          form.documents[0].url,
        )
      const active = await getActiveRecurringExpenses(group.id, {
        readOnly: true,
      })
      assert.equal(active.length, 1)
      await deleteExpense(group.id, active[0].id)
      const before = await prisma.expense.count({
        where: { groupId: group.id },
      })
      await getGroupExpenses(group.id)
      assert.equal(
        await prisma.expense.count({ where: { groupId: group.id } }),
        before,
      )
      assert.deepEqual(
        await getActiveRecurringExpenses(group.id, { readOnly: true }),
        [],
      )
    },
  )
  await check(
    'MCP returns deleted revision history, denies foreign groups, and leaves database counts unchanged',
    async () => {
      const token = 'isolated-audit-test-mcp-key-at-least-thirty-two-characters'
      process.env.MCP_ACCESS_GRANTS = JSON.stringify({
        users: [{ id: 'audit-tester', groupIds: [group.id] }],
        keys: [
          {
            id: 'audit-agent',
            userId: 'audit-tester',
            tokenSha256: hashAccessKey(token),
          },
        ],
      })
      const { POST } = await import('../src/app/api/mcp/route')
      const counts = async () => ({
        expenses: await prisma.expense.count(),
        activity: await prisma.activity.count(),
      })
      const before = await counts()
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await POST(
          new Request('http://localhost:3001/api/mcp', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name, arguments: args },
            }),
          }),
        )
        assert.equal(response.status, 200)
        const text = await response.text()
        const body = z.object({ result: z.unknown() }).parse(
          JSON.parse(
            text
              .split('\n')
              .find((line) => line.startsWith('data: '))
              ?.slice(6) ?? text,
          ),
        )
        return CallToolResultSchema.parse(body.result)
      }
      const result = await call('list_activity', {
        groupId: group.id,
        expenseId: expense.id,
        limit: 1,
      })
      assert.notEqual(result.isError, true)
      const page = z
        .object({
          activities: z.array(
            z.object({
              activityType: z.string(),
              snapshot: z.unknown().nullable(),
              previousSnapshot: expenseSnapshotSchema.nullable(),
            }),
          ),
          hasMore: z.boolean(),
        })
        .parse(result.structuredContent)
      assert.equal(page.activities[0].activityType, 'DELETE_EXPENSE')
      assert.equal(page.activities[0].snapshot, null)
      assert.equal(page.activities[0].previousSnapshot?.expense.amount, 9000)
      assert.equal(page.hasMore, true)
      assert.equal(
        (
          await call('list_activity', {
            groupId: other.id,
            expenseId: expense.id,
          })
        ).isError,
        true,
      )
      assert.equal(
        (
          await call('get_expense', {
            groupId: group.id,
            expenseId: expense.id,
          })
        ).isError,
        true,
      )
      assert.deepEqual(await counts(), before)
    },
  )
  await check(
    'exports exclude deleted current expenses and include preserved revisions in JSON',
    async () => {
      const { GET: jsonExport } =
        await import('../src/app/groups/[groupId]/expenses/export/json/route')
      const { GET: csvExport } =
        await import('../src/app/groups/[groupId]/expenses/export/csv/route')
      const request = new Request('http://localhost:3001/export')
      const context = { params: Promise.resolve({ groupId: group.id }) }
      const output = z
        .object({
          expenses: z.array(z.object({ id: z.string() })),
          activities: z.array(
            z.object({
              expenseId: z.string().nullable(),
              snapshot: z.unknown().nullable(),
            }),
          ),
        })
        .parse(await (await jsonExport(request, context)).json())
      assert(!output.expenses.some((row) => row.id === expense.id))
      assert(
        output.activities.some(
          (event) => event.expenseId === expense.id && event.snapshot !== null,
        ),
      )
      const csv = await (await csvExport(request, context)).text()
      assert(!csv.includes('Updated dinner'))
      assert(csv.includes('Original dinner'))
    },
  )
  await check(
    'percentage and amount splits remain canonical through the shared backend validation path',
    async () => {
      for (const mode of ['BY_PERCENTAGE', 'BY_AMOUNT'] as const) {
        const shares =
          mode === 'BY_PERCENTAGE'
            ? ['33.33', '33.33', '33.34']
            : ['1500', '2500', '2000']
        const values = expenseFormSchema.parse({
          ...form,
          title: `${mode} audit test`,
          splitMode: mode,
          paidFor: [alice, bob, carol].map((person, index) => ({
            participant: person.id,
            shares: shares[index],
          })),
        })
        const created = await createExpense(values, group.id)
        const saved = await getExpense(group.id, created.id)
        assert.deepEqual(
          saved?.paidFor.map((person) => person.shares).sort((a, b) => a - b),
          values.paidFor.map((person) => person.shares).sort((a, b) => a - b),
        )
        await updateExpense(group.id, created.id, {
          ...values,
          notes: 'Updated through the same validator',
        })
        const history = await getActivities(group.id, { expenseId: created.id })
        const latest = expenseSnapshotSchema.parse(history[0].snapshot)
        assert.equal(latest.expense.splitMode, mode)
        assert.deepEqual(
          latest.expense.paidFor
            .map((person) => person.shares)
            .sort((a, b) => a - b),
          values.paidFor.map((person) => person.shares).sort((a, b) => a - b),
        )
      }
    },
  )
  await check(
    'removing receipt references preserves the previous revision and does not move another expense document',
    async () => {
      const created = await createExpense(
        { ...form, title: 'Receipt retention test' },
        group.id,
      )
      const receipt = (await getExpense(group.id, created.id))?.documents[0]
      assert(receipt)
      const second = await createExpense(
        {
          ...form,
          title: 'Other receipt retention test',
          documents: [{ ...receipt }],
        },
        group.id,
      )
      await updateExpense(group.id, created.id, {
        ...form,
        title: 'Receipt removed',
        documents: [],
      })
      const history = await getActivities(group.id, { expenseId: created.id })
      assert.equal(
        expenseSnapshotSchema.parse(history[0].snapshot).expense.documents
          .length,
        0,
      )
      assert.equal(
        expenseSnapshotSchema.parse(history[0].previousSnapshot).expense
          .documents[0].url,
        receipt.url,
      )
      assert.equal(
        (await getExpense(group.id, second.id))?.documents[0].url,
        receipt.url,
      )
    },
  )
  await writeFile(
    '/private/tmp/agentsplit-audit-test-report.json',
    JSON.stringify(
      { passed, groupId: group.id, expenseId: expense.id },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  console.log(`Passed ${passed.length} PostgreSQL integration scenarios`)
} finally {
  await prisma.$disconnect()
}
