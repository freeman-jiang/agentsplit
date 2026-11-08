// What one synthetic person does: app opens in a real browser (Chromium from
// the dev shell, through Playwright), and an agent's MCP traffic with an API
// key, as Claude Code sends it. Every unit throws on a refused or failed
// request, so a rate limit that a run meets stops it instead of skewing it.
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { SESSION_REFRESH_KEY } from '../../src/shared/account'
import { MCP_PATH } from '../../src/shared/mcp'
import { randomId } from '../../src/shared/ids'
import { LEGACY } from '../../test/kit/mcp'
import { noteText, type Credentials, type Random, type SyntheticUser } from './seed'

/** How long one browser step may wait before the run fails. */
const STEP_MS = 30_000

export type Clients = {
  readonly edge: string
  readonly browser: Browser
  readonly credentialsOf: (userId: string) => Credentials
}

/** One browser context per person, made on first use: its cookie jar holds the session, and its cache the SPA page's ETag. */
export function contexts(clients: Clients) {
  const open = new Map<string, Promise<BrowserContext>>()
  const of = (u: SyntheticUser) => {
    let context = open.get(u.userId)
    if (!context) {
      context = (async () => {
        const made = await clients.browser.newContext({ baseURL: clients.edge, extraHTTPHeaders: { 'x-forwarded-for': u.ip }, serviceWorkers: 'block' })
        const { cookie } = clients.credentialsOf(u.userId)
        await made.addCookies([{ name: cookie.name, value: cookie.value, url: clients.edge, httpOnly: true, sameSite: 'Lax' }])
        // The month's opens run minutes apart here, but a person's are hours or days apart: each page load refreshes the session, as then.
        await made.addInitScript((key) => localStorage.removeItem(key), SESSION_REFRESH_KEY)
        made.setDefaultTimeout(STEP_MS)
        return made
      })()
      open.set(u.userId, context)
    }
    return context
  }
  const closeAll = async () => {
    for (const context of open.values()) await (await context).close()
  }
  return { of, closeAll }
}

/**
 * Watches a page's requests. `settle` waits until every request has its
 * answer and none has started for 500 ms. The edge sends an answer only once
 * the server has sent all of it, so the server's work is done then. (Not
 * Playwright's networkidle: the SPA never reads the body of its get-session
 * call, so Chromium keeps that request open.) `check` fails on a 4xx or 5xx
 * answer or a failed request: the run must not count refused work as served.
 */
function watch(page: Page) {
  const failures: string[] = []
  let open = 0
  let last = performance.now()
  page.on('request', () => {
    open++
    last = performance.now()
  })
  page.on('response', (response) => {
    open--
    last = performance.now()
    if (response.status() >= 400) failures.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`)
  })
  page.on('requestfailed', (request) => {
    open--
    failures.push(`failed ${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? ''}`)
  })
  return {
    settle: async () => {
      const deadline = performance.now() + STEP_MS
      while (open > 0 || performance.now() - last < 500) {
        if (performance.now() > deadline) throw new Error(`${open} requests still open after ${STEP_MS} ms`)
        await Bun.sleep(25)
      }
    },
    check: () => {
      if (failures.length) throw new Error(`The browser met failed requests: ${failures.join('; ')}`)
    },
  }
}

/**
 * An app open: the PWA's start page (the dashboard), then Groups, then the
 * person's group with its expense list. Each screen after the first is a
 * client-side navigation, as when a person taps through the app.
 */
async function openGroup(page: Page, u: SyntheticUser) {
  await page.goto('/')
  await page.getByTestId('dashboard-balance').waitFor()
  await page.getByRole('link', { name: 'Groups', exact: true }).first().click()
  await page.getByRole('link', { name: u.home.name, exact: true }).first().click()
  await page.getByTestId('expense-list').waitFor()
}

export async function appOpen(data: { context: BrowserContext; user: SyntheticUser }) {
  const page = await data.context.newPage()
  const { settle, check } = watch(page)
  try {
    await openGroup(page, data.user)
    await settle()
    check()
  } finally {
    await page.close()
  }
}

/** An app open that adds an expense through the form: a description, an amount and a text note, split evenly. */
export async function appOpenWithExpense(data: { context: BrowserContext; user: SyntheticUser; random: Random }) {
  const page = await data.context.newPage()
  const { settle, check } = watch(page)
  try {
    await openGroup(page, data.user)
    await page.getByRole('link', { name: 'Add expense', exact: true }).first().click()
    await page.getByLabel('Description').fill(`Groceries ${randomId(6)}`)
    await page.getByLabel('Amount', { exact: true }).fill(((500 + Math.floor(data.random() * 20000)) / 100).toFixed(2))
    await page.getByText('Notes and receipts').click()
    await page.getByLabel('Notes', { exact: true }).fill(noteText(data.random))
    await page.getByRole('button', { name: 'Add expense', exact: true }).click()
    await page.getByTestId('expense-list').waitFor()
    await settle()
    check()
  } finally {
    await page.close()
  }
}

type McpAnswer = { readonly status: number; readonly body: { readonly result?: McpResult; readonly error?: { readonly message: string } } | null }
type McpResult = {
  readonly isError?: boolean
  readonly capabilities?: Readonly<Record<string, object>>
  readonly content?: readonly { readonly text: string }[]
}

/** One HTTP request to /api/mcp with the person's API key, as an MCP client sends it. */
async function mcp(data: { clients: Clients; user: SyntheticUser; method: 'GET' | 'POST'; message?: object; initialized: boolean }): Promise<McpAnswer> {
  const { apiKey } = data.clients.credentialsOf(data.user.userId)
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    accept: data.method === 'GET' ? 'text/event-stream' : 'application/json, text/event-stream',
    'x-forwarded-for': data.user.ip,
    'user-agent': 'claude-code/2.1.314',
  }
  if (data.method === 'POST') headers['content-type'] = 'application/json'
  // The client sends the negotiated version on every request after initialize.
  if (data.initialized) headers['mcp-protocol-version'] = LEGACY
  const response = await fetch(new URL(MCP_PATH, data.clients.edge), { method: data.method, headers, ...(data.message ? { body: JSON.stringify(data.message) } : {}) })
  const text = await response.text()
  if (response.status === 429) throw new Error(`MCP rate limit met (${text}): run with more --users`)
  // A JSON-mode answer may come as one SSE event.
  const json = text.match(/^data: (.*)$/m)?.[1] ?? text
  return { status: response.status, body: json && data.method === 'POST' ? (JSON.parse(json) as McpAnswer['body']) : null }
}

let nextId = 1

/** Fails unless the JSON-RPC call answered 200 with a result that is not an error. */
function ok(answer: McpAnswer, what: string): McpResult {
  const result = answer.body?.result
  if (answer.status !== 200 || !result || result.isError) throw new Error(`${what} failed: ${answer.status} ${JSON.stringify(answer.body).slice(0, 500)}`)
  return result
}

/**
 * The start of an agent session, as Claude Code's MCP client (the TypeScript
 * SDK's Streamable HTTP transport) sends it: initialize, the initialized
 * notification, a GET for the server's event stream (the stateless server
 * refuses it), and a list of each capability that the server announces.
 */
export async function agentConnect(data: { clients: Clients; user: SyntheticUser }) {
  const base = { clients: data.clients, user: data.user }
  const init = await mcp({
    ...base,
    method: 'POST',
    initialized: false,
    message: { jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: { roots: {} }, clientInfo: { name: 'claude-code', version: '2.1.314' } } },
  })
  const capabilities = ok(init, 'initialize').capabilities ?? {}
  const notified = await mcp({ ...base, method: 'POST', initialized: true, message: { jsonrpc: '2.0', method: 'notifications/initialized' } })
  if (notified.status !== 202 && notified.status !== 200) throw new Error(`notifications/initialized answered ${notified.status}`)
  const stream = await mcp({ ...base, method: 'GET', initialized: true })
  if (stream.status !== 405 && stream.status !== 200) throw new Error(`The event-stream GET answered ${stream.status}`)
  for (const capability of ['tools', 'prompts', 'resources'] as const) {
    if (!(capability in capabilities)) continue
    ok(await mcp({ ...base, method: 'POST', initialized: true, message: { jsonrpc: '2.0', id: nextId++, method: `${capability}/list`, params: {} } }), `${capability}/list`)
  }
}

/** The read tools an agent uses, in turn: what it calls to answer "what do I owe" or "what did we spend". */
export const READ_TOOLS = ['list_groups', 'get_group', 'list_expenses', 'get_balances'] as const

/** One read tool call in the person's group. */
export async function agentRead(data: { clients: Clients; user: SyntheticUser; tool: (typeof READ_TOOLS)[number] }) {
  const args = data.tool === 'list_groups' ? {} : { groupId: data.user.home.id }
  ok(
    await mcp({ clients: data.clients, user: data.user, method: 'POST', initialized: true, message: { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: data.tool, arguments: args } } }),
    data.tool,
  )
}

/** create_expense in the person's group, paid by them and split evenly, with a text note and no receipt. */
export async function agentWrite(data: { clients: Clients; user: SyntheticUser; random: Random; today: string }) {
  const { user, random } = data
  const expense = {
    title: `Takeout ${randomId(6)}`,
    vendor: 'Corner Deli',
    expenseDate: data.today,
    amount: ((500 + Math.floor(random() * 20000)) / 100).toFixed(2),
    currencyCode: 'USD',
    paidBy: user.participantId,
    paidFor: user.home.participants.map((participant) => ({ participant, shares: '1' })),
    isReimbursement: false,
    notes: noteText(random),
  }
  ok(
    await mcp({
      clients: data.clients,
      user,
      method: 'POST',
      initialized: true,
      message: { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'create_expense', arguments: { groupId: user.home.id, expenseId: randomId(), expense } } },
    }),
    'create_expense',
  )
}
