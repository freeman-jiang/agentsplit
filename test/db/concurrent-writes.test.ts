// Concurrent writes to one group, from people on the web and from agents.
// SERIALIZABLE makes the colliding transactions fail with 40001, and the
// server retries them (serializable in src/server/core/db.ts). Without a
// pause between attempts, the same transactions collided again, and the
// retries ran out: the write answered as an outage, only under load.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { draft, mcpExpense } from '../kit/drafts'
import { counter, id21Counter } from '../kit/ids'
import { startHarness, webRpc, type Harness } from './harness'

let h: Harness
const cookies: Record<string, string> = {}
const keys: Record<string, Record<string, string>> = {}
const people = ['cw-pa', 'cw-pb', 'cw-pc']
const users = ['cw-alice', 'cw-bob', 'cw-cara']
beforeAll(async () => {
  h = await startHarness()
  for (const user of users) {
    cookies[user] = (await h.account(user)).cookie
    keys[user] = { 'x-api-key': await h.apiKey(user) }
  }
  await h.group({
    id: 'cw',
    people,
    members: [
      ['cw-alice', 'cw-pa', 'admin'],
      ['cw-bob', 'cw-pb', 'member'],
      ['cw-cara', 'cw-pc', 'member'],
    ],
  })
})
afterAll(() => h.close())

const expenseId = id21Counter('cw')
const idempotencyKey = counter('cw-key')

describe('concurrent writes to one group', () => {
  it('all succeed, from the web and from agents, and the balances add up', async () => {
    // 24 expenses of 30.00 at once, split evenly; each person pays 8, half on the web and half through MCP.
    const writes = Array.from({ length: 24 }, (_, i) => {
      const n = i % 3
      const user = users[n] ?? ''
      const payer = people[n] ?? ''
      if (i % 2 === 0)
        return webRpc(h, {
          tag: 'expenses.create',
          cookie: cookies[user] ?? '',
          payload: { groupId: 'cw', expenseId: expenseId(), idempotencyKey: `${idempotencyKey()}-0000`, expense: draft({ payer, people }) },
        }).then(({ exit }) => (exit._tag === 'Success' ? 'ok' : JSON.stringify(exit)))
      return h.mcp
        .callTool({ name: 'create_expense', args: { groupId: 'cw', expense: mcpExpense({ paidBy: payer, people }) }, headers: keys[user] ?? {} })
        .then((reply) => (reply.status === 200 && reply.result && !reply.result.isError ? 'ok' : JSON.stringify(reply.result ?? reply.body)))
    })
    const results = await Promise.all(writes)
    expect(results.filter((r) => r !== 'ok')).toEqual([])

    const { exit } = await webRpc(h, { tag: 'balances.list', cookie: cookies['cw-alice'] ?? '', payload: { groupId: 'cw' } })
    expect(exit).toMatchObject({
      _tag: 'Success',
      value: {
        currencies: [
          {
            currency: 'USD',
            balances: expect.arrayContaining(people.map((participantId) => ({ participantId, paid: '240.00', owed: '240.00', net: '0.00' }))),
          },
        ],
      },
    })
  })

  it('runs a write once when an agent sends it again at the same time with the same idempotency key', async () => {
    const id = expenseId()
    const payload = { groupId: 'cw', expenseId: id, idempotencyKey: `${idempotencyKey()}-0000`, expense: draft({ payer: 'cw-pa', people, title: 'Twice' }) }
    const results = await Promise.all(Array.from({ length: 6 }, () => webRpc(h, { tag: 'expenses.create', cookie: cookies['cw-alice'] ?? '', payload })))
    expect(results.map(({ exit }) => exit._tag)).toEqual(Array.from({ length: 6 }, () => 'Success'))
    const { exit } = await webRpc(h, { tag: 'expenses.list', cookie: cookies['cw-alice'] ?? '', payload: { groupId: 'cw', filter: { search: 'Twice' }, cursor: null, limit: 50 } })
    expect(exit).toMatchObject({ _tag: 'Success', value: { expenses: [{ id }] } })
  })
})
