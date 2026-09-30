/** @jest-environment node */

import { hashAccessKey } from '@/lib/mcp/access'
import {
  CallToolResultSchema,
  InitializeResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/core'
import * as z from 'zod'
import { POST } from './route'

var mockExpenseReads = jest.fn()
var mockRecurringReads = jest.fn()
const token = 'alice-integration-key-with-more-than-thirty-two-characters'
const secondToken = 'bob-integration-key-with-more-than-thirty-two-characters'
const groupA = {
  id: 'group-a',
  name: 'Group A',
  currency: '$',
  currencyCode: 'USD',
  createdAt: new Date('2026-09-30T00:00:00Z'),
  participants: [
    { id: 'alice', name: 'Alice' },
    { id: 'bob', name: 'Bob' },
  ],
}
const groupB = { ...groupA, id: 'group-b', name: 'Group B' }
const savedExpenses = [
  {
    id: 'expense-a',
    groupId: 'group-a',
    title: 'Dinner',
    amount: 6000,
    createdAt: new Date('2026-09-30T00:00:00Z'),
    expenseDate: new Date('2026-09-30T00:00:00Z'),
    paidBy: { id: 'alice', name: 'Alice' },
    category: null,
    paidFor: [
      { participant: { id: 'alice', name: 'Alice' }, shares: 1 },
      { participant: { id: 'bob', name: 'Bob' }, shares: 1 },
    ],
    splitMode: 'EVENLY',
    documents: [],
  },
  { id: 'expense-b', groupId: 'group-b', title: 'Private group B expense' },
]

jest.mock('../../../lib/prisma', () => ({
  prisma: {
    group: {
      findUnique: ({ where }: { where: { id: string } }) =>
        [groupA, groupB].find((group) => group.id === where.id) ?? null,
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        [groupA, groupB].filter((group) => where.id.in.includes(group.id)),
    },
    expense: {
      findMany: (...args: unknown[]) => mockExpenseReads(...args),
      findUnique: ({ where }: { where: { id: string; groupId: string } }) =>
        savedExpenses.find(
          (expense) =>
            expense.id === where.id && expense.groupId === where.groupId,
        ) ?? null,
    },
    recurringExpenseLink: {
      findMany: (...args: unknown[]) => mockRecurringReads(...args),
    },
    category: {
      findMany: () => [{ id: 0, name: 'General', grouping: 'Uncategorized' }],
    },
  },
}))
jest.mock('../../../generated/prisma/client', () => ({
  ...jest.requireActual('../../../generated/prisma/browser'),
  Prisma: { Decimal: jest.requireActual('decimal.js') },
}))
jest.mock('../../../lib/random', () => ({
  randomId: () => 'test-record-id',
}))
jest.mock('../../../lib/env', () => ({
  env: {},
  effectiveBaseUrl: 'https://app.test',
}))
jest.mock('superjson', () => ({
  __esModule: true,
  default: {
    registerCustom: () => {},
    serialize: (value: unknown) => ({ json: value }),
    deserialize: ({ json }: { json: unknown }) => json,
  },
}))

const originalConfig = process.env.MCP_ACCESS_GRANTS
beforeEach(() => {
  mockExpenseReads
    .mockReset()
    .mockImplementation(({ where }: { where: { groupId: string } }) =>
      savedExpenses.filter((expense) => expense.groupId === where.groupId),
    )
  mockRecurringReads.mockReset().mockResolvedValue([])
  process.env.MCP_ACCESS_GRANTS = JSON.stringify({
    users: [
      { id: 'alice', groupIds: ['group-a'] },
      { id: 'bob', groupIds: ['group-b'] },
    ],
    keys: [
      { id: 'alice-agent', userId: 'alice', tokenSha256: hashAccessKey(token) },
      {
        id: 'bob-agent',
        userId: 'bob',
        tokenSha256: hashAccessKey(secondToken),
      },
    ],
  })
})
afterAll(() => {
  if (originalConfig === undefined) delete process.env.MCP_ACCESS_GRANTS
  else process.env.MCP_ACCESS_GRANTS = originalConfig
})

async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  key = token,
) {
  const response = await POST(
    new Request('https://app.test/api/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  )
  const text = await response.text()
  const data =
    text
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice(6) ?? text
  const body = z
    .object({ result: z.unknown().optional(), error: z.unknown().optional() })
    .parse(JSON.parse(data))
  return { status: response.status, body }
}

function groupIds(result: unknown) {
  const output = CallToolResultSchema.parse(result)
  return z
    .object({ groups: z.array(z.object({ id: z.string() })) })
    .parse(output.structuredContent)
    .groups.map((group) => group.id)
}

describe('authenticated MCP protocol', () => {
  it('initializes a Codex-compatible client connection', async () => {
    const { status, body } = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'codex-verification', version: '1.0.0' },
    })
    expect(status).toBe(200)
    const initialized = InitializeResultSchema.parse(body.result)
    expect(initialized.serverInfo.name).toBe('agentsplit')
    expect(initialized.capabilities.tools).toBeDefined()
  })

  it('advertises only the selected read-only tools with real input schemas', async () => {
    const { status, body } = await rpc('tools/list')
    expect(status).toBe(200)
    const { tools } = ListToolsResultSchema.parse(body.result)
    expect(tools).toHaveLength(7)
    expect(tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true)
    expect(
      tools.find((tool) => tool.name === 'get_expense')?.inputSchema.required,
    ).toEqual(expect.arrayContaining(['groupId', 'expenseId']))
  })

  it('lists the current user groups without requiring the agent to know IDs', async () => {
    const { body } = await rpc('tools/call', {
      name: 'list_groups',
      arguments: {},
    })
    expect(groupIds(body.result)).toEqual(['group-a'])
  })

  it('validates arguments through tRPC and fails unauthorized group reads', async () => {
    const { body } = await rpc('tools/call', {
      name: 'get_group',
      arguments: { groupId: 'group-b', userId: 'bob' },
    })
    expect(CallToolResultSchema.parse(body.result).isError).toBe(true)
    const invalid = await rpc('tools/call', {
      name: 'list_expenses',
      arguments: { groupId: 'group-a', limit: 0 },
    })
    expect(CallToolResultSchema.parse(invalid.body.result).isError).toBe(true)
  })

  it('pages all user memberships without narrowing the agent key', async () => {
    process.env.MCP_ACCESS_GRANTS = JSON.stringify({
      users: [{ id: 'alice', groupIds: ['group-a', 'group-b'] }],
      keys: [
        {
          id: 'alice-agent',
          userId: 'alice',
          tokenSha256: hashAccessKey(token),
        },
      ],
    })
    const first = await rpc('tools/call', {
      name: 'list_groups',
      arguments: { limit: 1 },
    })
    expect(groupIds(first.body.result)).toEqual(['group-a'])
    const page = z
      .object({ hasMore: z.boolean(), nextCursor: z.number() })
      .parse(CallToolResultSchema.parse(first.body.result).structuredContent)
    expect(page.hasMore).toBe(true)
    const second = await rpc('tools/call', {
      name: 'list_groups',
      arguments: { limit: 1, cursor: page.nextCursor },
    })
    expect(groupIds(second.body.result)).toEqual(['group-b'])
  })

  it('returns saved expenses and balances without processing recurrence', async () => {
    const expenses = await rpc('tools/call', {
      name: 'list_expenses',
      arguments: { groupId: 'group-a' },
    })
    const expenseData = z
      .object({ expenses: z.array(z.object({ amount: z.number() })) })
      .parse(CallToolResultSchema.parse(expenses.body.result).structuredContent)
    expect(expenseData.expenses[0].amount).toBe(6000)
    const balances = await rpc('tools/call', {
      name: 'get_balances',
      arguments: { groupId: 'group-a' },
    })
    const balanceData = z
      .object({
        balances: z.record(z.string(), z.object({ total: z.number() })),
      })
      .parse(CallToolResultSchema.parse(balances.body.result).structuredContent)
    expect(balanceData.balances.alice.total).toBe(3000)
    expect(mockRecurringReads).not.toHaveBeenCalled()
  })

  it('does not return another group expense even when a wrong group is supplied', async () => {
    const { body } = await rpc('tools/call', {
      name: 'get_expense',
      arguments: { groupId: 'group-a', expenseId: 'expense-b' },
    })
    expect(CallToolResultSchema.parse(body.result).isError).toBe(true)
    expect(JSON.stringify(body)).not.toContain('Private group B expense')
  })

  it('isolates two concurrent users with identical JSON-RPC request IDs', async () => {
    const replies = await Promise.all([
      rpc('tools/call', { name: 'list_groups', arguments: {} }, token),
      rpc('tools/call', { name: 'list_groups', arguments: {} }, secondToken),
    ])
    expect(groupIds(replies[0].body.result)).toEqual(['group-a'])
    expect(groupIds(replies[1].body.result)).toEqual(['group-b'])
  })

  it('does not expose a mutation tool', async () => {
    const { body } = await rpc('tools/call', {
      name: 'create_expense',
      arguments: {},
    })
    expect(
      body.error || CallToolResultSchema.parse(body.result).isError,
    ).toBeTruthy()
    expect(mockExpenseReads).not.toHaveBeenCalled()
  })
})
