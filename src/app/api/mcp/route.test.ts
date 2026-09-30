/** @jest-environment node */

import { accessConfigurationSchema, hashAccessKey } from '@/lib/mcp/access'
import { MCP_OUTPUT_SCHEMAS } from '@/lib/mcp/output-schemas'
import { MCP_TOOL_REGISTRY } from '@/lib/mcp/registry'
import { appRouter } from '@/trpc/routers/_app'
import {
  CallToolResultSchema,
  InitializeResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/core'
import type { AnyTRPCRouter } from '@trpc/server'
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
  information: null,
  _count: { participants: 2 },
  createdAt: new Date('2026-09-30T00:00:00Z'),
  participants: [
    { id: 'alice', name: 'Alice', groupId: 'group-a' },
    { id: 'bob', name: 'Bob', groupId: 'group-a' },
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
    paidById: 'alice',
    paidBy: { id: 'alice', name: 'Alice', groupId: 'group-a' },
    categoryId: 0,
    category: null,
    paidFor: [
      {
        expenseId: 'expense-a',
        participantId: 'alice',
        participant: { id: 'alice', name: 'Alice' },
        shares: 1,
      },
      {
        expenseId: 'expense-a',
        participantId: 'bob',
        participant: { id: 'bob', name: 'Bob' },
        shares: 1,
      },
    ],
    splitMode: 'EVENLY',
    documents: [],
    _count: { documents: 0 },
    isReimbursement: false,
    originalAmount: null,
    originalCurrency: null,
    conversionRate: null,
    notes: null,
    recurrenceRule: 'NONE',
    recurringExpenseLink: null,
    recurringExpenseLinkId: null,
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
    expensePaidFor: {
      findMany: () => [{ participantId: 'alice' }, { participantId: 'bob' }],
    },
    activity: {
      findMany: () => [
        {
          id: 'activity-a',
          groupId: 'group-a',
          time: new Date('2026-09-30T00:00:00Z'),
          activityType: 'CREATE_EXPENSE',
          participantId: 'alice',
          expenseId: 'expense-a',
          data: 'Dinner',
        },
      ],
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
let clock = Date.now()
beforeEach(() => {
  clock += 120_000
  jest.spyOn(Date, 'now').mockReturnValue(clock)
  mockExpenseReads
    .mockReset()
    .mockImplementation(
      ({ where }: { where: { groupId: string; recurrenceRule?: unknown } }) =>
        where.recurrenceRule
          ? []
          : savedExpenses.filter(
              (expense) => expense.groupId === where.groupId,
            ),
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
afterEach(() => jest.restoreAllMocks())
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
    expect(tools).toHaveLength(12)
    expect(tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true)
    expect(tools.every((tool) => tool.outputSchema?.type === 'object')).toBe(
      true,
    )
    expect(
      tools.find((tool) => tool.name === 'list_categories')?.inputSchema
        .additionalProperties,
    ).toBe(false)
    const router: AnyTRPCRouter = appRouter
    const queries = Object.keys(router._def.procedures)
      .filter((path) => router._def.procedures[path]._def.type === 'query')
      .sort()
    expect(MCP_TOOL_REGISTRY.map((tool) => tool.procedure).sort()).toEqual(
      queries,
    )
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

  it.each([
    ['get_group', { groupId: 'group-a' }],
    ['get_group_details', { groupId: 'group-a' }],
    ['get_expense', { groupId: 'group-a', expenseId: 'expense-a' }],
    ['list_activity', { groupId: 'group-a' }],
    ['list_categories', {}],
    [
      'get_participant_balances',
      { groups: [{ groupId: 'group-a', participantId: 'alice' }] },
    ],
    ['get_spending_stats', { groupId: 'group-a', participantId: 'alice' }],
    ['list_category_expenses', { groupId: 'group-a', categoryId: 0 }],
    ['list_month_expenses', { groupId: 'group-a', month: '2026-09' }],
  ] as const)(
    'returns a validated result for %s without materializing recurrence',
    async (name, args) => {
      const { body } = await rpc('tools/call', { name, arguments: args })
      const result = CallToolResultSchema.parse(body.result)
      expect(result.isError).not.toBe(true)
      const definition = MCP_TOOL_REGISTRY.find((tool) => tool.name === name)!
      expect(() =>
        MCP_OUTPUT_SCHEMAS[definition.procedure].parse(
          result.structuredContent,
        ),
      ).not.toThrow()
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify(result.structuredContent) },
      ])
      expect(mockRecurringReads).not.toHaveBeenCalled()
    },
  )

  it('rejects an entire multi-group balance request before reading any database rows', async () => {
    const { body } = await rpc('tools/call', {
      name: 'get_participant_balances',
      arguments: {
        groups: [
          { groupId: 'group-a', participantId: 'alice' },
          { groupId: 'group-b', participantId: 'bob' },
        ],
      },
    })
    expect(CallToolResultSchema.parse(body.result).isError).toBe(true)
    expect(mockExpenseReads).not.toHaveBeenCalled()
  })

  it('does not return malformed database output or private parser diagnostics', async () => {
    mockExpenseReads.mockResolvedValue([
      { ...savedExpenses[0], amount: 'private-invalid-database-value' },
    ])
    const { body } = await rpc('tools/call', {
      name: 'list_expenses',
      arguments: { groupId: 'group-a' },
    })
    expect(CallToolResultSchema.parse(body.result).isError).toBe(true)
    expect(JSON.stringify(body)).not.toContain('private-invalid-database-value')
  })

  it('rate limits before executing further tools and lets another user continue', async () => {
    const sameUserToken =
      'alice-second-integration-key-over-thirty-two-characters'
    const config = accessConfigurationSchema.parse(
      JSON.parse(process.env.MCP_ACCESS_GRANTS!),
    )
    config.keys.push({
      id: 'alice-second-agent',
      userId: 'alice',
      tokenSha256: hashAccessKey(sameUserToken),
    })
    process.env.MCP_ACCESS_GRANTS = JSON.stringify(config)
    for (let i = 0; i < 120; i++)
      expect((await rpc('tools/list')).status).toBe(200)
    expect(
      (
        await rpc('tools/call', {
          name: 'list_expenses',
          arguments: { groupId: 'group-a' },
        })
      ).status,
    ).toBe(429)
    expect(mockExpenseReads).not.toHaveBeenCalled()
    expect((await rpc('tools/list', {}, sameUserToken)).status).toBe(429)
    expect((await rpc('tools/list', {}, secondToken)).status).toBe(200)
    clock += 500
    jest.spyOn(Date, 'now').mockReturnValue(clock)
    expect((await rpc('tools/list')).status).toBe(200)
  })

  it('computes statistics and cross-group balances in minor units with matching drilldowns', async () => {
    const stats = CallToolResultSchema.parse(
      (
        await rpc('tools/call', {
          name: 'get_spending_stats',
          arguments: {
            groupId: 'group-a',
            participantId: 'alice',
            from: '2026-09-01',
            to: '2026-09-30',
          },
        })
      ).body.result,
    ).structuredContent
    expect(stats).toEqual(
      expect.objectContaining({
        totalGroupSpendings: 6000,
        totalParticipantShare: 3000,
        totalParticipantSpendings: 6000,
      }),
    )
    const balances = CallToolResultSchema.parse(
      (
        await rpc('tools/call', {
          name: 'get_participant_balances',
          arguments: { groups: [{ groupId: 'group-a', participantId: 'bob' }] },
        })
      ).body.result,
    ).structuredContent
    expect(balances).toEqual({
      balances: [
        expect.objectContaining({
          amount: -3000,
          currencyCode: 'USD',
          participantId: 'bob',
        }),
      ],
    })
    const outsideRange = CallToolResultSchema.parse(
      (
        await rpc('tools/call', {
          name: 'list_category_expenses',
          arguments: { groupId: 'group-a', categoryId: 0, to: '2026-08-31' },
        })
      ).body.result,
    ).structuredContent
    expect(outsideRange).toEqual({ expenses: [] })
    const month = CallToolResultSchema.parse(
      (
        await rpc('tools/call', {
          name: 'list_month_expenses',
          arguments: { groupId: 'group-a', month: '2026-09' },
        })
      ).body.result,
    ).structuredContent
    expect(month).toEqual({
      expenses: [expect.objectContaining({ id: 'expense-a', amount: 6000 })],
    })
  })

  it.each([
    'get_group_details',
    'get_spending_stats',
    'list_category_expenses',
    'list_month_expenses',
  ])('rejects unauthorized reads through %s', async (name) => {
    const { body } = await rpc('tools/call', {
      name,
      arguments: { groupId: 'group-b', categoryId: 0, month: '2026-09' },
    })
    expect(CallToolResultSchema.parse(body.result).isError).toBe(true)
    expect(mockExpenseReads).not.toHaveBeenCalled()
  })

  it.each([
    ['tools/list', undefined],
    ['tools/call', 'list_categories'],
  ])(
    'serves modern %s requests and validates standard header mismatches',
    async (method, name) => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': method,
        ...(name ? { 'Mcp-Name': name } : {}),
      }
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method,
        params: {
          ...(name ? { name, arguments: {} } : {}),
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': {
              name: 'test-client',
              version: '1.0',
            },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      })
      const response = await POST(
        new Request('https://app.test/api/mcp', {
          method: 'POST',
          headers,
          body,
        }),
      )
      expect(response.status).toBe(200)
      const reply = z
        .object({ result: z.unknown() })
        .parse(await response.json())
      if (name)
        expect(CallToolResultSchema.parse(reply.result).isError).not.toBe(true)
      else
        expect(ListToolsResultSchema.parse(reply.result).tools).toHaveLength(12)
      headers['Mcp-Method'] = 'wrong-method'
      const mismatch = await POST(
        new Request('https://app.test/api/mcp', {
          method: 'POST',
          headers,
          body,
        }),
      )
      expect(mismatch.status).toBe(400)
      expect(await mismatch.json()).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({ code: -32020 }),
        }),
      )
    },
  )

  it('returns the standard JSON-RPC error with the request ID for a missing modern version header', async () => {
    const response = await POST(
      new Request('https://app.test/api/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'modern-check',
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': {
                name: 'test-client',
                version: '1.0',
              },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 'modern-check',
      error: { code: -32020, message: 'MCP-Protocol-Version is required' },
    })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})
