// The expenses area against a real database: receipts on expenses, recurring
// series, balances with settlements, and the edit screen's detail read.
import { eq, sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activities, expenses, groups, memberships, participants, receipts, recurringLinks } from '../../db/schema/app'
import { user } from '../../db/schema/auth'
import type { ExpenseDraft } from '~/shared/expense-rules'
import { makeDb, type Db } from '~/server/db'
import { getExpenseContext, getExpenseDetail, listBalances, listCategories } from '~/server/expenses'
import { createExpense, deleteExpense, getGroup, listExpenses, updateExpense } from '~/server/ledger'
import { type Principal } from '~/server/access'
import { downloadReceipt, uploadReceipt } from '~/server/receipts'
import { fakeBucket } from './fake-bucket'
import { listRecurring, materializeDue, processGroup } from '~/server/recurring'
import { resetTestDatabase, testUsers } from './setup'

let pool: Pool
const alice: Principal = { userId: 'u-alice', name: 'Alice', email: 'a@example.com', source: 'web', agentKeyId: null }
const bob: Principal = { userId: 'u-bob', name: 'Bob', email: 'b@example.com', source: 'web', agentKeyId: null }
const mallory: Principal = { userId: 'u-mallory', name: 'Mallory', email: 'm@example.com', source: 'web', agentKeyId: null }

async function tx<A>(work: (db: Db) => Promise<A>): Promise<A> {
  const client = await pool.connect()
  try {
    return await makeDb(client).transaction(work, { isolationLevel: 'serializable' })
  } finally {
    client.release()
  }
}
let keys = 0
const key = () => `key-${++keys}-expenses-test`

beforeAll(async () => {
  pool = await resetTestDatabase()
  await tx(async (db) => {
    await db.insert(groups).values([
      { id: 'g1', kind: 'named', slug: 'home', name: 'Home', defaultCurrency: 'USD' },
      { id: 'g2', kind: 'named', slug: 'other', name: 'Other', defaultCurrency: 'USD' },
    ])
    await db.insert(participants).values([
      { id: 'pa', groupId: 'g1', name: 'Alice' },
      { id: 'pb', groupId: 'g1', name: 'Bob' },
      { id: 'pc', groupId: 'g1', name: 'Cara' },
      { id: 'pm', groupId: 'g2', name: 'Mallory' },
    ])
    await db.insert(user).values(testUsers([alice, bob, mallory]))
    await db.insert(memberships).values([
      { userId: alice.userId, groupId: 'g1', role: 'admin', participantId: 'pa' },
      { userId: bob.userId, groupId: 'g1', role: 'member', participantId: 'pb' },
      { userId: mallory.userId, groupId: 'g2', role: 'admin', participantId: 'pm' },
    ])
    await db.insert(receipts).values([
      { id: 'r1', groupId: 'g1', url: 'r2://agentsplit-receipts/receipts/aaaaaaaaaaaaaaaaaaaaa.jpg', createdBy: alice.userId },
      { id: 'r2', groupId: 'g1', url: 'https://s3.example/bucket/receipts/bbbbbbbbbbbbbbbbbbbbb.png', createdBy: alice.userId },
      { id: 'r3', groupId: 'g2', url: 'r2://agentsplit-receipts/receipts/ccccccccccccccccccccc.jpg', createdBy: mallory.userId },
    ])
  })
})
afterAll(async () => {
  await pool.end()
})

const draft = (over: Partial<ExpenseDraft> = {}): ExpenseDraft => ({
  kind: 'expense',
  title: 'Groceries',
  vendor: 'Costco',
  notes: '',
  categoryId: 9,
  expenseDate: '2026-11-01',
  currency: 'USD',
  amount: '90.00',
  payers: [{ participantId: 'pa', amount: '90.00' }],
  splitMode: 'evenly',
  shares: [{ participantId: 'pa', weight: '1' }, { participantId: 'pb', weight: '1' }, { participantId: 'pc', weight: '1' }],
  recurrence: 'none',
  ...over,
})
const doc1 = { id: 'd1', url: 'r2://agentsplit-receipts/receipts/aaaaaaaaaaaaaaaaaaaaa.jpg', width: 10, height: 20 }
const doc2 = { id: 'd2', url: 'https://s3.example/bucket/receipts/bbbbbbbbbbbbbbbbbbbbb.png', width: 30, height: 40 }
const snapshotOf = async (expenseId: string, revision: number) => {
  const all = await tx((db) => db.select().from(activities).where(eq(activities.expenseId, expenseId)))
  return all.find((a) => a.expenseRevision === revision)?.snapshot as { expense: { documents: { url: string }[] } } | undefined
}

describe('expense writes', () => {
  it('lists categories in ID order', async () => {
    const list = await tx((db) => listCategories(db))
    expect(list).toHaveLength(44)
    expect(list.map((c) => c.id)).toEqual([...Array(44).keys()])
    expect(list[43]).toEqual({ id: 43, grouping: 'Life', name: 'Donation' })
  })

  it('records receipts in revision 1 and keeps them when an update omits them', async () => {
    await tx((db) => createExpense(db, { principal: alice, group: 'home', expenseId: 'x1', idempotencyKey: key(), expense: draft(), documents: [doc1] }))
    expect((await snapshotOf('x1', 1))?.expense.documents.map((d) => d.url)).toEqual([doc1.url])
    const updated = await tx((db) => updateExpense(db, { principal: alice, group: 'g1', expenseId: 'x1', expectedRevision: 1, idempotencyKey: key(), expense: draft({ title: 'Food' }) }))
    expect(updated.documentCount).toBe(1)
  })

  it('removing a receipt keeps it in the earlier revision, readable by members', async () => {
    await tx((db) => updateExpense(db, { principal: alice, group: 'g1', expenseId: 'x1', expectedRevision: 2, idempotencyKey: key(), expense: draft({ title: 'Food' }), documents: [doc2] }))
    expect((await snapshotOf('x1', 2))?.expense.documents.map((d) => d.url)).toEqual([doc1.url])
    expect((await snapshotOf('x1', 3))?.expense.documents.map((d) => d.url)).toEqual([doc2.url])
    const detail = await tx((db) => getExpenseDetail(db, { principal: bob, group: 'g1', expenseId: 'x1' }))
    expect(detail.documents.map((d) => d.downloadUrl)).toEqual([`/api/receipts?groupId=g1&url=${encodeURIComponent(doc2.url)}`])
  })

  it('lists receipts in the order they were attached, as the current app does', async () => {
    const docs = [5, 1, 4, 2, 3].map((n) => ({ id: `o${n}`, url: `r2://agentsplit-receipts/receipts/order${n}.jpg`, width: n, height: n }))
    await tx((db) => db.insert(receipts).values(docs.map((d) => ({ id: `r-${d.id}`, groupId: 'g1', url: d.url, createdBy: alice.userId }))))
    const [first, ...others] = docs
    await tx((db) => createExpense(db, { principal: alice, group: 'g1', expenseId: 'ordered', idempotencyKey: key(), expense: draft(), documents: others }))
    const urls = async () => (await tx((db) => getExpenseDetail(db, { principal: alice, group: 'g1', expenseId: 'ordered' }))).documents.map((d) => d.url)
    expect(await urls()).toEqual(others.map((d) => d.url))
    // A receipt attached later comes last, and the revision keeps the same order.
    const saved = await tx((db) => getExpenseDetail(db, { principal: alice, group: 'g1', expenseId: 'ordered' }))
    const kept = saved.documents.map((d) => ({ id: d.id, url: d.url, width: d.width, height: d.height }))
    await tx((db) => updateExpense(db, { principal: alice, group: 'g1', expenseId: 'ordered', expectedRevision: 1, idempotencyKey: key(), expense: draft(), documents: [...kept, ...(first ? [first] : [])] }))
    expect(await urls()).toEqual([...others, ...(first ? [first] : [])].map((d) => d.url))
    expect((await snapshotOf('ordered', 2))?.expense.documents.map((d) => d.url)).toEqual(await urls())
    // The balance tests below count every live expense of g1.
    await tx((db) => deleteExpense(db, { principal: alice, group: 'g1', expenseId: 'ordered', expectedRevision: 2, idempotencyKey: key() }))
  })

  it('refuses a receipt that was not uploaded to the group', async () => {
    const foreign = { id: 'd3', url: 'r2://agentsplit-receipts/receipts/ccccccccccccccccccccc.jpg', width: 1, height: 1 }
    await expect(
      tx((db) => createExpense(db, { principal: alice, group: 'g1', expenseId: 'x2', idempotencyKey: key(), expense: draft(), documents: [foreign] })),
    ).rejects.toMatchObject({ _tag: 'Invalid', message: 'Attach only receipts uploaded to this group' })
  })

  it('refuses a reused expense ID with Conflict and an unknown category with Invalid', async () => {
    await expect(tx((db) => createExpense(db, { principal: alice, group: 'g1', expenseId: 'x1', idempotencyKey: key(), expense: draft() }))).rejects.toMatchObject({
      _tag: 'Conflict',
      currentRevision: 3,
    })
    await expect(tx((db) => createExpense(db, { principal: alice, group: 'g1', expenseId: 'x2', idempotencyKey: key(), expense: draft({ categoryId: 99 }) }))).rejects.toMatchObject({
      _tag: 'Invalid',
      field: 'categoryId',
    })
  })

  it('adds no revision for an edit that changes nothing', async () => {
    const same = await tx((db) =>
      updateExpense(db, { principal: alice, group: 'g1', expenseId: 'x1', expectedRevision: 3, idempotencyKey: key(), expense: draft({ title: 'Food' }), documents: [doc2] }),
    )
    expect(same.revision).toBe(3)
  })

  it('drops a legacy conversion when the amount changes, and keeps it otherwise', async () => {
    // Only imported rows carry a conversion: insert one as the importer does, at revision 0.
    await tx(async (db) => {
      await db.execute(sql`INSERT INTO expenses (id, group_id, revision, kind, title, notes, category_id, expense_date, currency, amount, split_mode, original_amount, original_currency, conversion_rate)
        VALUES ('conv', 'g1', 0, 'expense', 'Groceries', '', 9, '2026-11-01', 'USD', 9000, 'evenly', 12000, 'CAD', '0.75')`)
      await db.execute(sql`INSERT INTO expense_payers (expense_id, group_id, participant_id, amount) VALUES ('conv', 'g1', 'pa', 9000)`)
      await db.execute(sql`INSERT INTO expense_shares (expense_id, group_id, participant_id, amount) VALUES ('conv', 'g1', 'pa', 3000), ('conv', 'g1', 'pb', 3000), ('conv', 'g1', 'pc', 3000)`)
    })
    const conversion = async () => (await tx((db) => db.select({ c: expenses.originalCurrency }).from(expenses).where(eq(expenses.id, 'conv'))))[0]?.c
    await tx((db) => updateExpense(db, { principal: alice, group: 'g1', expenseId: 'conv', expectedRevision: 0, idempotencyKey: key(), expense: draft({ title: 'Renamed', vendor: null }) }))
    expect(await conversion()).toBe('CAD')
    await tx((db) => updateExpense(db, { principal: alice, group: 'g1', expenseId: 'conv', expectedRevision: 1, idempotencyKey: key(), expense: draft({ title: 'Renamed', vendor: null, amount: '60.00', payers: [{ participantId: 'pa', amount: '60.00' }] }) }))
    expect(await conversion()).toBeNull()
    await tx((db) => deleteExpense(db, { principal: alice, group: 'g1', expenseId: 'conv', expectedRevision: 2, idempotencyKey: key() }))
  })

  it('names who added and who last edited an expense', async () => {
    await tx((db) => updateExpense(db, { principal: bob, group: 'g1', expenseId: 'x1', expectedRevision: 3, idempotencyKey: key(), expense: draft({ title: 'Food and drink' }) }))
    const detail = await tx((db) => getExpenseDetail(db, { principal: alice, group: 'g1', expenseId: 'x1' }))
    expect(detail.added?.by).toBe('Alice')
    expect(detail.edited?.by).toBe('Bob')
    expect(detail.myLastEdit).not.toBeNull()
    const page = await tx((db) => listExpenses(db, { principal: alice, group: 'g1', filter: {}, cursor: null, limit: 10 }))
    expect(page.expenses.find((e) => e.id === 'x1')).toMatchObject({ addedBy: 'Alice', editedBy: 'Bob' })
  })

  it('finds an expense from any accessible group, and nothing for others', async () => {
    expect(await tx((db) => getExpenseContext(db, { principal: bob, expenseId: 'x1' }))).toMatchObject({ groupId: 'g1', slug: 'home', kind: 'expense' })
    await expect(tx((db) => getExpenseContext(db, { principal: mallory, expenseId: 'x1' }))).rejects.toMatchObject({ _tag: 'NotFound' })
    await expect(tx((db) => getExpenseDetail(db, { principal: mallory, group: 'g1', expenseId: 'x1' }))).rejects.toMatchObject({ _tag: 'Forbidden' })
  })
})

describe('payments and balances', () => {
  it('suggests settlements per currency, lists every participant, and settles to zero', async () => {
    const before = await tx((db) => listBalances(db, { principal: alice, group: 'g1' }))
    const usd = before.currencies.find((c) => c.currency === 'USD')
    expect(usd?.balances.map((b) => b.participantId).sort()).toEqual(['pa', 'pb', 'pc'])
    expect(usd?.settlements).toEqual([
      { from: 'pc', to: 'pa', amount: '30.00' },
      { from: 'pb', to: 'pa', amount: '30.00' },
    ])
    for (const s of usd?.settlements ?? [])
      await tx((db) =>
        createExpense(db, {
          principal: alice,
          group: 'g1',
          expenseId: `pay-${s.from}`,
          idempotencyKey: key(),
          expense: draft({ kind: 'payment', title: 'Payment', vendor: null, categoryId: 1, amount: s.amount, payers: [{ participantId: s.from, amount: s.amount }], shares: [{ participantId: s.to, weight: '1' }] }),
        }),
      )
    const after = await tx((db) => listBalances(db, { principal: alice, group: 'g1' }))
    expect(after.currencies.find((c) => c.currency === 'USD')?.balances.map((b) => b.net)).toEqual(['0.00', '0.00', '0.00'])
    expect(after.currencies.find((c) => c.currency === 'USD')?.settlements).toEqual([])
  })

  it('keeps currencies apart and filters by currency', async () => {
    await tx((db) =>
      createExpense(db, {
        principal: alice,
        group: 'g1',
        expenseId: 'yen',
        idempotencyKey: key(),
        expense: draft({ currency: 'JPY', amount: '6000', payers: [{ participantId: 'pb', amount: '6000' }] }),
      }),
    )
    const all = await tx((db) => listBalances(db, { principal: alice, group: 'g1' }))
    expect(all.currencies.map((c) => c.currency)).toEqual(['JPY', 'USD'])
    const jpy = await tx((db) => listBalances(db, { principal: alice, group: 'g1', currency: 'JPY' }))
    expect(jpy.currencies).toHaveLength(1)
    expect(jpy.currencies[0]?.settlements).toEqual([
      { from: 'pc', to: 'pb', amount: '2000' },
      { from: 'pa', to: 'pb', amount: '2000' },
    ])
    await expect(tx((db) => listBalances(db, { principal: mallory, group: 'g1' }))).rejects.toMatchObject({ _tag: 'Forbidden' })
  })

  it('accepts a payment shared by several people, and a negative one (P-BAL-93)', async () => {
    const refund = await tx((db) =>
      createExpense(db, {
        principal: alice,
        group: 'g1',
        expenseId: 'refund',
        idempotencyKey: key(),
        expense: draft({ kind: 'payment', title: 'Refund', amount: '-30.00', payers: [{ participantId: 'pa', amount: '-30.00' }] }),
      }),
    )
    expect(refund.shares.map((s) => s.amount)).toEqual(['-10.00', '-10.00', '-10.00'])
    await tx((db) => deleteExpense(db, { principal: alice, group: 'g1', expenseId: 'refund', expectedRevision: 1, idempotencyKey: key() }))
  })
})

describe('recurring expenses', () => {
  const run = (today: string, principal?: Principal) =>
    materializeDue({ today, transaction: (work) => tx(work), ...(principal ? { principal } : {}) })

  it('creates every missed month on the anchor day, once, with copies of the receipts', async () => {
    await tx((db) =>
      createExpense(db, { principal: alice, group: 'g1', expenseId: 'rent', idempotencyKey: key(), expense: draft({ title: 'Rent', expenseDate: '2026-01-31', recurrence: 'monthly' }), documents: [doc1] }),
    )
    // Reads never create occurrences.
    await tx((db) => listExpenses(db, { principal: alice, group: 'g1', filter: { search: 'Rent' }, cursor: null, limit: 50 }))
    await tx((db) => getGroup(db, { principal: alice, group: 'g1' }))
    expect((await tx((db) => listExpenses(db, { principal: alice, group: 'g1', filter: { search: 'Rent' }, cursor: null, limit: 50 }))).expenses).toHaveLength(1)

    const created = await run('2026-04-05')
    expect(created).toHaveLength(2)
    const rents = await tx((db) => listExpenses(db, { principal: alice, group: 'g1', filter: { search: 'Rent' }, cursor: null, limit: 50 }))
    expect(rents.expenses.map((e) => e.expenseDate)).toEqual(['2026-03-31', '2026-02-28', '2026-01-31'])
    expect(rents.expenses.every((e) => e.documentCount === 1 && e.vendor === 'Costco')).toBe(true)
    expect(rents.expenses[0]?.addedBy).toBe('Automatic recurrence')
    // A rerun, and a run on the same day, create nothing.
    expect(await run('2026-04-05')).toEqual([])
    const [series] = await tx((db) => listRecurring(db, { principal: alice, group: 'g1' }))
    expect(series).toMatchObject({ expense: { expenseDate: '2026-03-31' }, nextDate: '2026-04-30' })
  })

  it('never duplicates when two runs race', async () => {
    await tx((db) =>
      createExpense(db, { principal: alice, group: 'g1', expenseId: 'daily', idempotencyKey: key(), expense: draft({ title: 'Coffee', expenseDate: '2026-03-01', recurrence: 'daily' }) }),
    )
    const results = await Promise.allSettled([run('2026-03-06'), run('2026-03-06'), run('2026-03-06')])
    const coffee = await tx((db) => listExpenses(db, { principal: alice, group: 'g1', filter: { search: 'Coffee' }, cursor: null, limit: 50 }))
    expect(coffee.expenses.map((e) => e.expenseDate)).toEqual(['2026-03-06', '2026-03-05', '2026-03-04', '2026-03-03', '2026-03-02', '2026-03-01'])
    // A run that lost a race may fail; the next run would continue.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
  })

  it('stops a series when its newest expense is set to none or deleted', async () => {
    const newest = (await tx((db) => listExpenses(db, { principal: alice, group: 'g1', filter: { search: 'Coffee' }, cursor: null, limit: 1 }))).expenses[0]
    if (!newest) throw new Error('missing occurrence')
    await tx((db) =>
      updateExpense(db, { principal: alice, group: 'g1', expenseId: newest.id, expectedRevision: 1, idempotencyKey: key(), expense: draft({ title: 'Coffee', expenseDate: newest.expenseDate, recurrence: 'none' }) }),
    )
    expect(await run('2026-03-20')).toEqual([])
    const [rent] = (await tx((db) => listRecurring(db, { principal: alice, group: 'g1' }))).map((r) => r.expense)
    if (!rent) throw new Error('missing series')
    await tx((db) => deleteExpense(db, { principal: alice, group: 'g1', expenseId: rent.id, expectedRevision: 1, idempotencyKey: key() }))
    expect(await tx((db) => listRecurring(db, { principal: alice, group: 'g1' }))).toEqual([])
    expect(await run('2026-12-31')).toEqual([])
  })

  it('counts an edited rule or date from the saved date, and never restarts an older occurrence', async () => {
    await tx((db) =>
      createExpense(db, { principal: alice, group: 'g1', expenseId: 'gym', idempotencyKey: key(), expense: draft({ title: 'Gym', expenseDate: '2026-05-10', recurrence: 'monthly' }) }),
    )
    await tx((db) =>
      updateExpense(db, { principal: alice, group: 'g1', expenseId: 'gym', expectedRevision: 1, idempotencyKey: key(), expense: draft({ title: 'Gym', expenseDate: '2026-05-12', recurrence: 'weekly' }) }),
    )
    const [link] = await tx((db) => db.select().from(recurringLinks).where(eq(recurringLinks.currentFrameExpenseId, 'gym')))
    expect(link).toMatchObject({ nextExpenseDate: '2026-05-19', anchorDay: 12 })
    expect(await run('2026-05-19')).toHaveLength(1)
    // The older occurrence's link is closed: changing its rule does not open a new one.
    await tx((db) =>
      updateExpense(db, { principal: alice, group: 'g1', expenseId: 'gym', expectedRevision: 2, idempotencyKey: key(), expense: draft({ title: 'Gym', expenseDate: '2026-05-12', recurrence: 'daily' }) }),
    )
    const links = await tx((db) => db.select().from(recurringLinks).where(eq(recurringLinks.groupId, 'g1')))
    expect(links.filter((l) => l.currentFrameExpenseId === 'gym')).toHaveLength(1)
    expect(links.filter((l) => !l.nextExpenseCreatedAt).map((l) => l.nextExpenseDate)).toEqual(['2026-05-26'])
  })

  it('lets a member process one group only, and records them', async () => {
    const client = await pool.connect()
    try {
      await expect(processGroup(makeDb(client), { principal: mallory, group: 'g1', today: '2026-06-30', transaction: tx })).rejects.toMatchObject({ _tag: 'Forbidden' })
      const { createdExpenseIds } = await processGroup(makeDb(client), { principal: bob, group: 'home', today: '2026-05-26', transaction: tx })
      expect(createdExpenseIds).toHaveLength(1)
      const [row] = await tx((db) => db.select().from(activities).where(eq(activities.expenseId, createdExpenseIds[0] ?? '')))
      expect(row).toMatchObject({ actorName: 'Bob', source: 'web' })
    } finally {
      client.release()
    }
    const [gym] = await tx((db) => db.select({ deleted: expenses.deletedAt }).from(expenses).where(eq(expenses.id, 'gym')))
    expect(gym?.deleted).toBeNull()
  })
})

// ---------- receipts over HTTP ----------

const png = (width: number, height: number) => {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

describe('receipt endpoints', () => {
  const base = 'http://localhost:5182'
  const get = (params: Record<string, string>) => new URL(`${base}/api/receipts?${new URLSearchParams(params)}`)

  it('checks the reference, the session and the membership before reading storage', async () => {
    const { bucket, calls } = fakeBucket()
    const client = await pool.connect()
    const db = makeDb(client)
    try {
      expect((await downloadReceipt({ db, bucket, principal: alice, url: get({ groupId: 'g1' }) })).status).toBe(400)
      expect((await downloadReceipt({ db, bucket, principal: null, url: get({ groupId: 'g1', url: doc1.url }) })).status).toBe(401)
      const denied = await downloadReceipt({ db, bucket, principal: mallory, url: get({ groupId: 'g1', url: doc1.url }) })
      expect(denied.status).toBe(403)
      expect(denied.headers.get('cache-control')).toBe('no-store')
      expect(await denied.json()).toEqual({ error: 'Group not found, or you are not a member' })
      // PostgreSQL text cannot hold a NUL byte: such a reference is denied or not found, never a database error.
      expect((await downloadReceipt({ db, bucket, principal: alice, url: get({ groupId: 'g1\0', url: doc1.url }) })).status).toBe(403)
      expect((await downloadReceipt({ db, bucket, principal: alice, url: get({ groupId: 'g1', url: `${doc1.url}\0` }) })).status).toBe(404)
      // Another group's receipt is not found through this group.
      expect((await downloadReceipt({ db, bucket, principal: alice, url: get({ groupId: 'g1', url: 'r2://agentsplit-receipts/receipts/ccccccccccccccccccccc.jpg' }) })).status).toBe(404)
      expect(calls).toEqual([])
      // Registered, but missing in storage.
      expect((await downloadReceipt({ db, bucket, principal: alice, url: get({ groupId: 'home', url: doc1.url }) })).status).toBe(404)
    } finally {
      client.release()
    }
  })

  it('uploads to the bucket for a member on the app origin, and serves the image with safe headers', async () => {
    const { bucket, objects } = fakeBucket()
    const client = await pool.connect()
    const db = makeDb(client)
    // A browser sends Content-Length with a multipart body; Node's Request does not, so set it as a browser would.
    const post = async (data: { origin?: string; body?: FormData; length?: string }) => {
      const encoded = new Request(base, { method: 'POST', body: data.body ?? new FormData() })
      const bytes = await encoded.arrayBuffer()
      const headers = { origin: data.origin ?? base, 'content-type': encoded.headers.get('content-type') ?? '', 'content-length': data.length ?? String(bytes.byteLength) }
      return new Request(`${base}/api/receipts`, { method: 'POST', body: bytes, headers })
    }
    const form = (groupId: string, bytes: Uint8Array<ArrayBuffer>) => {
      const f = new FormData()
      f.set('groupId', groupId)
      f.set('file', new File([bytes], 'receipt.png', { type: 'image/jpeg' }))
      return f
    }
    const upload = async (request: Promise<Request>, principal: Principal | null = alice) => uploadReceipt({ db, bucket, principal, request: await request, baseUrl: base })
    try {
      expect((await upload(post({ origin: 'https://evil.example', body: form('g1', png(1, 1)) }))).status).toBe(403)
      expect((await upload(post({ body: form('g1', png(1, 1)) }), null)).status).toBe(401)
      expect((await upload(post({ body: form('g1', png(1, 1)), length: String(6 * 1024 * 1024) }))).status).toBe(413)
      expect((await upload(post({ body: form('g2', png(1, 1)) }))).status).toBe(403)
      const bad = await upload(post({ body: form('g1', new TextEncoder().encode('not an image at all, really')) }))
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ error: 'Could not upload receipt. Use a JPEG or PNG image up to 5 MiB.' })
      expect((await upload(post({ body: form('g1', png(8000, 6000)) }))).status).toBe(400)

      const ok = await upload(post({ body: form('home', png(64, 48)) }))
      expect(ok.status).toBe(200)
      const stored = (await ok.json()) as { id: string; url: string; width: number; height: number }
      expect(stored).toMatchObject({ width: 64, height: 48 })
      expect(stored.url).toMatch(/^r2:\/\/agentsplit-receipts\/receipts\/[A-Za-z0-9_-]{21}\.png$/)
      // The detected type wins over the declared image/jpeg.
      expect([...objects.values()][0]?.contentType).toBe('image/png')

      const image = await downloadReceipt({ db, bucket, principal: bob, url: get({ groupId: 'g1', url: stored.url }) })
      expect(image.status).toBe(200)
      expect(Object.fromEntries(image.headers)).toMatchObject({
        'content-type': 'image/png',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'content-disposition': 'inline',
      })
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(png(64, 48))
    } finally {
      client.release()
    }
  })

  it('serves a receipt that only a deleted expense refers to', async () => {
    const { bucket, objects } = fakeBucket()
    objects.set('receipts/aaaaaaaaaaaaaaaaaaaaa.jpg', { bytes: new Uint8Array([1]), contentType: 'image/jpeg' })
    const client = await pool.connect()
    try {
      const response = await downloadReceipt({ db: makeDb(client), bucket, principal: bob, url: get({ groupId: 'g1', url: doc1.url }) })
      expect(response.status).toBe(200)
    } finally {
      client.release()
    }
  })
})
