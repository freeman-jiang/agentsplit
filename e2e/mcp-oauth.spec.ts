import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { z } from 'zod'
import { createGroup, uniqueSuffix } from './app'
import { expect, test } from './fixtures'

const read = 'agentsplit:read',
  write = 'agentsplit:write'
async function mockAgent(baseURL: string) {
  const db = new URL(process.env.POSTGRES_PRISMA_URL ?? '')
  assert(
    ['127.0.0.1', 'localhost'].includes(db.hostname) &&
      /test|e2e/.test(db.pathname),
  )
  assert(['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname))
  const clientId = `browser-agent-${randomBytes(10).toString('hex')}`,
    name = `Mock browser agent ${uniqueSuffix()}`
  const pool = new Pool({ connectionString: db.href })
  try {
    await pool.query(
      'INSERT INTO "OauthClient" (id,"clientId",name,"redirectUris","tokenEndpointAuthMethod","grantTypes","responseTypes","requirePKCE","skipConsent",scopes) VALUES ($1,$1,$2,$3,\'none\',$4,$5,true,false,$6)',
      [
        clientId,
        name,
        ['https://mock-agent.example/callback'],
        ['authorization_code', 'refresh_token'],
        ['code'],
        ['openid', 'profile', 'email', 'offline_access', read, write],
      ],
    )
    await pool.query(
      'INSERT INTO "OauthClientResource" (id,"clientId","resourceId") VALUES ($1,$2,$3)',
      [`${clientId}-resource`, clientId, `${baseURL}/api/mcp`],
    )
  } finally {
    await pool.end()
  }
  function authorization() {
    const verifier = randomBytes(32).toString('base64url'),
      state = randomBytes(16).toString('hex')
    return {
      verifier,
      state,
      url: `${baseURL}/api/auth/oauth2/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: 'https://mock-agent.example/callback', response_type: 'code', scope: `openid profile email offline_access ${read} ${write}`, resource: `${baseURL}/api/mcp`, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state, prompt: 'consent', claims: JSON.stringify({ userinfo: { email: { essential: true } } }) })}`,
    }
  }
  return { clientId, name, authorization }
}
const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
})
const rpcSchema = z.object({
  result: z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z.unknown().optional(),
      _meta: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
})

test('fresh mock agent completes consent, uses MCP, rotates tokens and is revoked from settings', async ({
  page,
  baseURL,
  request,
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const groupId = await createGroup(page, {
    name: `OAuth browser ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob'],
  })
  await page.request.get('/.well-known/oauth-protected-resource/api/mcp')
  const agent = await mockAgent(baseURL!)
  await page.route('https://mock-agent.example/callback**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Mock agent connected</title><p>Authorization returned to the mock agent.</p>',
    }),
  )
  const a = agent.authorization()
  await page.goto(a.url)
  await expect(
    page.getByRole('heading', { name: `Connect ${agent.name} to AgentSplit` }),
  ).toBeVisible()
  await expect(
    page.getByText('Client identity:', { exact: false }),
  ).toContainText(agent.clientId)
  await expect(
    page.getByText('Requested access', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Additional requested profile fields: email.'),
  ).toBeVisible()
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: width === 1280 ? 1200 : 900 })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath(`oauth-consent-${width}.png`),
      fullPage: true,
    })
  }
  await page.getByRole('button', { name: 'Allow access', exact: true }).click()
  await page.waitForURL('https://mock-agent.example/callback**')
  const callback = new URL(page.url())
  expect(callback.searchParams.get('state')).toBe(a.state)
  const exchanged = await request.post(`${baseURL}/api/auth/oauth2/token`, {
    form: {
      grant_type: 'authorization_code',
      client_id: agent.clientId,
      redirect_uri: 'https://mock-agent.example/callback',
      code: callback.searchParams.get('code')!,
      code_verifier: a.verifier,
      resource: `${baseURL}/api/mcp`,
    },
  })
  expect(exchanged.status(), await exchanged.text()).toBe(200)
  const tokens = tokenSchema.parse(await exchanged.json())
  async function call(
    name: string,
    args: Record<string, unknown>,
    token = tokens.access_token,
  ) {
    const r = await request.post(`${baseURL}/api/mcp`, {
      headers: {
        Authorization: `Bearer ${token}`,
        accept: 'application/json,text/event-stream',
      },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      },
    })
    const text = await r.text()
    return {
      status: r.status(),
      body: rpcSchema.parse(
        JSON.parse(
          text
            .split('\n')
            .find((l) => l.startsWith('data: '))
            ?.slice(6) ?? text,
        ),
      ),
    }
  }
  const details = await call('get_group', { groupId })
  expect(details.status).toBe(200)
  const group = z
    .object({
      group: z.object({
        participants: z.array(z.object({ id: z.string(), name: z.string() })),
      }),
    })
    .parse(details.body.result?.structuredContent).group
  const alice = group.participants.find((p) => p.name === 'Alice')!,
    bob = group.participants.find((p) => p.name === 'Bob')!
  const expense = await call('create_expense', {
    groupId,
    expense: {
      title: 'Recorded by mock agent',
      vendor: 'Local test',
      amount: '24',
      currencyCode: 'USD',
      expenseDate: '2026-10-07',
      paidBy: bob.id,
      paidFor: [
        { participant: alice.id, shares: '1' },
        { participant: bob.id, shares: '1' },
      ],
      splitMode: 'EVENLY',
      isReimbursement: false,
    },
  })
  expect(expense.body.result?.isError).not.toBe(true)
  await page.goto(`${baseURL}/groups/${groupId}/expenses`)
  await expect(page.getByTestId('expense-card')).toContainText(
    'Recorded by mock agent',
  )
  await expect(page.getByTestId('expense-card')).toContainText('Added by Alice')
  await expect(page.getByTestId('expense-card')).toContainText('Bob paid')
  const refreshed = await request.post(`${baseURL}/api/auth/oauth2/token`, {
    form: {
      grant_type: 'refresh_token',
      client_id: agent.clientId,
      refresh_token: tokens.refresh_token,
      resource: `${baseURL}/api/mcp`,
    },
  })
  expect(refreshed.status()).toBe(200)
  const next = tokenSchema.parse(await refreshed.json())
  expect(next.refresh_token).not.toBe(tokens.refresh_token)
  expect((await call('get_group', { groupId }, next.access_token)).status).toBe(
    200,
  )
  await page.goto(`${baseURL}/settings/connections`)
  await expect(page.getByText(agent.name, { exact: true })).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('oauth-connected-apps.png'),
    fullPage: true,
  })
  page.once('dialog', (d) => d.accept())
  await page.getByRole('button', { name: 'Revoke access', exact: true }).click()
  await expect(page.getByText('No connected apps yet.')).toBeVisible()
  expect(
    (await call('get_group', { groupId }, tokens.access_token)).status,
  ).toBe(401)
  expect((await call('get_group', { groupId }, next.access_token)).status).toBe(
    401,
  )
  const denied = await request.post(`${baseURL}/api/auth/oauth2/token`, {
    form: {
      grant_type: 'refresh_token',
      client_id: agent.clientId,
      refresh_token: next.refresh_token,
      resource: `${baseURL}/api/mcp`,
    },
  })
  expect(denied.status()).toBeGreaterThanOrEqual(400)
  expect(errors).toEqual([])
})

test('browser can deny consent or connect read only; mock agent cannot upgrade itself', async ({
  page,
  baseURL,
  request,
}) => {
  await page.goto('/settings')
  await page.request.get('/.well-known/oauth-protected-resource/api/mcp')
  const agent = await mockAgent(baseURL!)
  await page.route('https://mock-agent.example/callback**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<p>Mock callback</p>',
    }),
  )
  const denied = agent.authorization()
  await page.goto(denied.url)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.waitForURL('https://mock-agent.example/callback**')
  expect(new URL(page.url()).searchParams.get('error')).toBe('access_denied')
  const a = agent.authorization()
  await page.goto(a.url)
  await page.getByRole('checkbox').uncheck()
  await page.getByRole('button', { name: 'Allow access', exact: true }).click()
  await page.waitForURL('https://mock-agent.example/callback**')
  const r = await request.post(`${baseURL}/api/auth/oauth2/token`, {
    form: {
      grant_type: 'authorization_code',
      client_id: agent.clientId,
      redirect_uri: 'https://mock-agent.example/callback',
      code: new URL(page.url()).searchParams.get('code')!,
      code_verifier: a.verifier,
      resource: `${baseURL}/api/mcp`,
    },
  })
  expect(r.status(), await r.text()).toBe(200)
  const tokens = tokenSchema.parse(await r.json())
  const response = await request.post(`${baseURL}/api/mcp`, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      accept: 'application/json,text/event-stream',
    },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_group',
        arguments: {
          group: {
            name: 'Must not create',
            currency: '$',
            currencyCode: 'USD',
            participants: [],
          },
        },
      },
    },
  })
  const text = await response.text(),
    body = rpcSchema.parse(
      JSON.parse(
        text
          .split('\n')
          .find((l) => l.startsWith('data: '))
          ?.slice(6) ?? text,
      ),
    )
  expect(body.result?.isError).toBe(true)
  expect(JSON.stringify(body.result?._meta)).toContain('insufficient_scope')
  const escalation = await request.post(`${baseURL}/api/auth/oauth2/token`, {
    form: {
      grant_type: 'refresh_token',
      client_id: agent.clientId,
      refresh_token: tokens.refresh_token,
      scope: `${read} ${write}`,
      resource: `${baseURL}/api/mcp`,
    },
  })
  expect(escalation.status()).toBeGreaterThanOrEqual(400)
})
