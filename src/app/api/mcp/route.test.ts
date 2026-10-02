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

jest.mock('../../../lib/mcp/authenticate', () => ({
  authenticateMcp: async (request: Request) =>
    require('../../../lib/mcp/access').authorizeMcpRequest(request),
}))
var mockExpenseReads = jest.fn()
var mockRecurringReads = jest.fn()
type ExpenseQuery = {
  where: {
    groupId: string
    currencyCode?: string
    recurrenceRule?: unknown
    expenseDate?: { gte?: Date; lte?: Date }
    title?: { contains: string }
  }
  skip?: number
  take?: number
}
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
    amount: '60',
    currencyCode: 'USD',
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
        shares: '1',
      },
      {
        expenseId: 'expense-a',
        participantId: 'bob',
        participant: { id: 'bob', name: 'Bob' },
        shares: '1',
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
    deletedAt: null,
    revision: 1,
  },
  { id: 'expense-b', groupId: 'group-b', title: 'Private group B expense' },
]

jest.mock('../../../lib/prisma', () => ({
  prisma: {
    userGroupAccess: {
      findMany: async ({ where }: { where: { userId: string } }) => {
        const config = accessConfigurationSchema.parse(
          JSON.parse(process.env.MCP_ACCESS_GRANTS!),
        )
        return (
          config.users.find((u: { id: string }) => u.id === where.userId)
            ?.groupIds ?? []
        ).map((groupId: string) => ({
          userId: where.userId,
          groupId,
          active: true,
          role: 'admin',
        }))
      },
      findUnique: async () => ({ active: true, role: 'admin' }),
    },
    user: { findMany: async () => [] },
    groupInvitation: { findMany: async () => [] },
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
          snapshot: null,
          expenseRevision: null,
          source: 'web',
          actorName: null,
          actorUserId: null,
          agentKeyId: null,
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
  effectiveBaseUrl: 'https://app.test',
  env: { NEXT_PUBLIC_ENABLE_EXPENSE_DOCUMENTS: false },
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
    .mockImplementation(({ where, skip = 0, take }: ExpenseQuery) =>
      where.recurrenceRule
        ? []
        : savedExpenses
            .filter(
              (expense) =>
                expense.groupId === where.groupId &&
                (!where.currencyCode ||
                  expense.currencyCode === where.currencyCode) &&
                (!where.title ||
                  expense.title
                    .toLowerCase()
                    .includes(where.title.contains.toLowerCase())) &&
                (!where.expenseDate ||
                  (expense.expenseDate &&
                    (!where.expenseDate.gte ||
                      expense.expenseDate >= where.expenseDate.gte) &&
                    (!where.expenseDate.lte ||
                      expense.expenseDate <= where.expenseDate.lte))),
            )
            .slice(skip, take === undefined ? undefined : skip + take),
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
    expect(initialized.instructions).toContain('decimal strings')
    expect(initialized.instructions).not.toContain('minor units')
  })

  it('advertises the reviewed read/write surface with real schemas', async () => {
    const { status, body } = await rpc('tools/list')
    expect(status).toBe(200)
    const { tools } = ListToolsResultSchema.parse(body.result)
    expect(tools).toHaveLength(17)
    expect(tools.map((tool) => tool.name)).not.toContain('list_month_expenses')
    expect(
      tools.find((tool) => tool.name === 'list_expenses')?.annotations
        ?.readOnlyHint,
    ).toBe(true)
    expect(
      tools.find((tool) => tool.name === 'create_expense')?.annotations
        ?.readOnlyHint,
    ).toBe(false)
    expect(
      tools.find((tool) => tool.name === 'delete_expense')?.annotations
        ?.destructiveHint,
    ).toBe(true)
    expect(tools.every((tool) => tool.outputSchema?.type === 'object')).toBe(
      true,
    )
    expect(
      tools.find((tool) => tool.name === 'get_reference_data')?.inputSchema
        .additionalProperties,
    ).toBe(false)
    const router: AnyTRPCRouter = appRouter
    expect(
      MCP_TOOL_REGISTRY.every((tool) =>
        ['query', 'mutation'].includes(
          router._def.procedures[tool.procedure]._def.type,
        ),
      ),
    ).toBe(true)
    expect(
      tools.find((tool) => tool.name === 'list_expenses')?.inputSchema
        .properties,
    ).toEqual(
      expect.objectContaining({
        from: expect.any(Object),
        to: expect.any(Object),
      }),
    )
    expect(
      tools.find((tool) => tool.name === 'get_expense')?.inputSchema.required,
    ).toEqual(expect.arrayContaining(['groupId', 'expenseId']))
    const createInput = tools.find(
      (tool) => tool.name === 'create_expense',
    )!.inputSchema
    expect(createInput.properties).toHaveProperty('expense')
    expect(createInput.properties).not.toHaveProperty('expenseFormValues')
    expect(createInput.properties).not.toHaveProperty('participantId')
    const publicExpense = z
      .object({ properties: z.record(z.string(), z.unknown()) })
      .parse(createInput.properties?.expense)
    expect(publicExpense.properties).not.toHaveProperty(
      'saveDefaultSplittingOptions',
    )
    expect(publicExpense.properties).not.toHaveProperty('conversionRate')
    expect(publicExpense.properties.expenseDate).toEqual(
      expect.objectContaining({ type: 'string', format: 'date' }),
    )
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
      .object({ expenses: z.array(z.object({ amount: z.string() })) })
      .parse(CallToolResultSchema.parse(expenses.body.result).structuredContent)
    expect(expenseData.expenses[0].amount).toBe('60')
    const balances = await rpc('tools/call', {
      name: 'get_balances',
      arguments: { groupId: 'group-a' },
    })
    const balanceData = z
      .object({
        currencies: z.array(
          z.object({
            currencyCode: z.string(),
            balances: z.record(z.string(), z.object({ total: z.string() })),
          }),
        ),
      })
      .parse(CallToolResultSchema.parse(balances.body.result).structuredContent)
    expect(balanceData.currencies[0].balances.alice.total).toBe('30')
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

  it('returns decimal-string balances per currency and filters before pagination', async () => {
    const dinner = savedExpenses[0]
    if (dinner.amount === undefined) throw new Error('Missing dinner fixture')
    savedExpenses.push({
      ...dinner,
      id: 'yen-expense',
      amount: '6000',
      currencyCode: 'JPY',
    })
    try {
      const balances = CallToolResultSchema.parse(
        (
          await rpc('tools/call', {
            name: 'get_balances',
            arguments: { groupId: 'group-a' },
          })
        ).body.result,
      )
      expect(balances.isError).not.toBe(true)
      const result = MCP_OUTPUT_SCHEMAS['groups.balances.list'].parse(
        balances.structuredContent,
      )
      expect(result.currencies.map((bucket) => bucket.currencyCode)).toEqual([
        'JPY',
        'USD',
      ])
      expect(result.currencies[0].balances.alice.total).toBe('3000')
      expect(result.currencies[1].balances.alice.total).toBe('30')
      const page = CallToolResultSchema.parse(
        (
          await rpc('tools/call', {
            name: 'list_expenses',
            arguments: { groupId: 'group-a', currencyCode: 'JPY', limit: 1 },
          })
        ).body.result,
      )
      expect(page.isError).not.toBe(true)
      const expenses = MCP_OUTPUT_SCHEMAS['groups.expenses.list'].parse(
        page.structuredContent,
      )
      expect(expenses.hasMore).toBe(false)
      expect(
        expenses.expenses.map((expense) => [
          expense.amount,
          expense.currencyCode,
        ]),
      ).toEqual([['6000', 'JPY']])
      const stats = CallToolResultSchema.parse(
        (
          await rpc('tools/call', {
            name: 'get_spending_stats',
            arguments: { groupId: 'group-a', currencyCode: 'JPY' },
          })
        ).body.result,
      )
      expect(stats.isError).not.toBe(true)
      expect(
        MCP_OUTPUT_SCHEMAS['groups.stats.overview'].parse(
          stats.structuredContent,
        ).totalGroupSpendings,
      ).toBe('6000')
      expect(mockRecurringReads).not.toHaveBeenCalled()
    } finally {
      savedExpenses.pop()
    }
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

  it('does not expose the removed month-specific tool', async () => {
    const { body } = await rpc('tools/call', {
      name: 'list_month_expenses',
      arguments: { groupId: 'group-a', month: '2026-09' },
    })
    expect(
      body.error || CallToolResultSchema.parse(body.result).isError,
    ).toBeTruthy()
    expect(mockExpenseReads).not.toHaveBeenCalled()
  })

  it.each([
    { from: '2026-09-31' },
    { from: '2026-02-29' },
    { to: '2026-09-30T12:00:00Z' },
    { from: '2026-10-01', to: '2026-09-30' },
  ])(
    'rejects invalid or reversed date bounds before a database read: %j',
    async (range) => {
      const { body } = await rpc('tools/call', {
        name: 'list_expenses',
        arguments: { groupId: 'group-a', ...range },
      })
      expect(CallToolResultSchema.parse(body.result).isError).toBe(true)
      expect(mockExpenseReads).not.toHaveBeenCalled()
    },
  )

  it.each([
    [{ from: '2026-09-30' }, ['expense-a']],
    [{ to: '2026-09-30' }, ['expense-a']],
    [{ from: '2026-09-30', to: '2026-09-30' }, ['expense-a']],
    [{ from: '2026-10-01' }, []],
    [{ to: '2026-09-29' }, []],
    [{ from: '2024-02-29', to: '2024-02-29' }, []],
  ] as const)(
    'supports inclusive and open date ranges: %j',
    async (range, expected) => {
      const { body } = await rpc('tools/call', {
        name: 'list_expenses',
        arguments: { groupId: 'group-a', ...range },
      })
      const output = CallToolResultSchema.parse(body.result)
      expect(output.isError).not.toBe(true)
      const page = z
        .object({ expenses: z.array(z.object({ id: z.string() })) })
        .parse(output.structuredContent)
      expect(page.expenses.map((expense) => expense.id)).toEqual(expected)
    },
  )

  it('paginates a date range with title filtering, including reimbursements and both boundary dates', async () => {
    const rows = [
      {
        ...savedExpenses[0],
        id: 'before',
        expenseDate: new Date('2026-08-31T00:00:00Z'),
      },
      {
        ...savedExpenses[0],
        id: 'first',
        expenseDate: new Date('2026-09-01T00:00:00Z'),
      },
      {
        ...savedExpenses[0],
        id: 'repayment',
        title: 'DINNER repayment',
        isReimbursement: true,
        expenseDate: new Date('2026-09-15T00:00:00Z'),
      },
      {
        ...savedExpenses[0],
        id: 'other-title',
        title: 'Lunch',
        expenseDate: new Date('2026-09-20T00:00:00Z'),
      },
      {
        ...savedExpenses[0],
        id: 'foreign-group',
        groupId: 'group-b',
        expenseDate: new Date('2026-09-25T00:00:00Z'),
      },
      {
        ...savedExpenses[0],
        id: 'last',
        expenseDate: new Date('2026-09-30T00:00:00Z'),
      },
      {
        ...savedExpenses[0],
        id: 'after',
        expenseDate: new Date('2026-10-01T00:00:00Z'),
      },
    ]
    mockExpenseReads.mockImplementation(
      ({ where, skip = 0, take }: ExpenseQuery) =>
        rows
          .filter(
            (row) =>
              row.groupId === where.groupId &&
              (!where.title ||
                row.title
                  .toLowerCase()
                  .includes(where.title.contains.toLowerCase())) &&
              (!where.expenseDate?.gte ||
                row.expenseDate >= where.expenseDate.gte) &&
              (!where.expenseDate?.lte ||
                row.expenseDate <= where.expenseDate.lte),
          )
          .sort((a, b) => b.expenseDate.getTime() - a.expenseDate.getTime())
          .slice(skip, take === undefined ? undefined : skip + take),
    )
    const found: { id: string; isReimbursement: boolean }[] = []
    let cursor = 0
    let hasMore = true
    while (hasMore) {
      const { body } = await rpc('tools/call', {
        name: 'list_expenses',
        arguments: {
          groupId: 'group-a',
          from: '2026-09-01',
          to: '2026-09-30',
          filter: 'DiNnEr',
          limit: 1,
          cursor,
        },
      })
      const output = CallToolResultSchema.parse(body.result)
      expect(output.isError).not.toBe(true)
      const page = z
        .object({
          expenses: z.array(
            z.object({ id: z.string(), isReimbursement: z.boolean() }),
          ),
          nextCursor: z.number(),
          hasMore: z.boolean(),
        })
        .parse(output.structuredContent)
      found.push(...page.expenses)
      expect(page.nextCursor).toBe(cursor + 1)
      cursor = page.nextCursor
      hasMore = page.hasMore
      if (cursor > rows.length) throw new Error('Pagination did not terminate')
    }
    expect(found).toEqual([
      { id: 'last', isReimbursement: false },
      { id: 'repayment', isReimbursement: true },
      { id: 'first', isReimbursement: false },
    ])
    expect(mockExpenseReads).toHaveBeenCalledTimes(3)
    expect(mockRecurringReads).not.toHaveBeenCalled()
    const allTime = CallToolResultSchema.parse(
      (
        await rpc('tools/call', {
          name: 'list_expenses',
          arguments: { groupId: 'group-a', limit: 100 },
        })
      ).body.result,
    )
    const allTimePage = z
      .object({
        expenses: z.array(z.object({ id: z.string() })),
        hasMore: z.boolean(),
      })
      .parse(allTime.structuredContent)
    expect(allTimePage.expenses.map((expense) => expense.id)).toEqual([
      'after',
      'last',
      'other-title',
      'repayment',
      'first',
      'before',
    ])
    expect(allTimePage.hasMore).toBe(false)
  })

  it.each([
    ['get_group', { groupId: 'group-a' }],
    ['get_expense', { groupId: 'group-a', expenseId: 'expense-a' }],
    ['list_activity', { groupId: 'group-a' }],
    ['get_reference_data', {}],
    [
      'get_participant_balances',
      { groups: [{ groupId: 'group-a', participantId: 'alice' }] },
    ],
    ['get_spending_stats', { groupId: 'group-a', participantId: 'alice' }],
    ['list_expenses', { groupId: 'group-a', categoryId: 0 }],
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
        totalGroupSpendings: '60',
        totalParticipantShare: '30',
        totalParticipantSpendings: '60',
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
          amount: '-30',
          currencyCode: 'USD',
          participantId: 'bob',
        }),
      ],
    })
    const outsideRange = CallToolResultSchema.parse(
      (
        await rpc('tools/call', {
          name: 'list_expenses',
          arguments: { groupId: 'group-a', categoryId: 0, to: '2026-08-31' },
        })
      ).body.result,
    ).structuredContent
    expect(outsideRange).toEqual(expect.objectContaining({ expenses: [] }))
    const month = CallToolResultSchema.parse(
      (
        await rpc('tools/call', {
          name: 'list_expenses',
          arguments: {
            groupId: 'group-a',
            from: '2026-09-01',
            to: '2026-09-30',
          },
        })
      ).body.result,
    ).structuredContent
    expect(month).toEqual({
      expenses: [expect.objectContaining({ id: 'expense-a', amount: '60' })],
      hasMore: false,
      nextCursor: 10,
    })
  })

  it.each([
    'get_group',
    'get_spending_stats',
    'list_expenses',
    'list_expenses',
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
    ['tools/call', 'get_reference_data'],
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
        expect(ListToolsResultSchema.parse(reply.result).tools).toHaveLength(17)
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
