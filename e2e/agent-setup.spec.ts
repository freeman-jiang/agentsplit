import { addExpense, createGroup, uniqueSuffix } from './app'
import { expect, test } from './fixtures'

test('signed-in workspace offers usable agent connection instructions', async ({
  page,
  baseURL,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 1000 })
  await page.goto('/')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator('a[href*="github.com"]')).toHaveCount(0)
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Agents' })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Set up your agent' }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Create an API key' }),
  ).toBeVisible()
  await expect(
    page.getByText(`${baseURL}/api/mcp`, { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'OAuth · Recommended', exact: true }),
  ).toBeVisible()
  await page
    .locator('summary')
    .filter({ hasText: /^ChatGPT$/ })
    .click()
  await expect(page.getByText('Base scopes', { exact: true })).toBeVisible()
  await expect(page.getByText('offline_access', { exact: true })).toBeVisible()
  await page
    .locator('summary')
    .filter({ hasText: /^Claude$/ })
    .click()
  await expect(page.getByText('Sign in now', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Use Claude’s published identity (Recommended)', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Official ChatGPT setup guide' }),
  ).toHaveAttribute('href', 'https://developers.openai.com/plugins/quickstart')
  await expect(
    page.getByRole('link', { name: 'Official Claude setup guide' }),
  ).toHaveAttribute(
    'href',
    'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp',
  )
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath(`agent-setup-${width}.png`),
      fullPage: true,
    })
  }
  await page.setViewportSize({ width: 320, height: 1000 })
  await page
    .locator('summary')
    .filter({ hasText: /^Codex app$/ })
    .click()
  await expect(
    page.getByText('your API key, exactly as copied', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('pre').first()).not.toBeVisible()
  await page
    .locator('summary')
    .filter({ hasText: 'Codex CLI and configuration files' })
    .click()
  await expect(page.locator('pre').first()).toContainText(
    'env_http_headers = { "X-API-Key" = "AGENTSPLIT_API_KEY" }',
  )
  await page
    .locator('summary')
    .filter({ hasText: 'Claude Code with an API key' })
    .click()
  await expect(page.locator('pre').nth(1)).toContainText(
    '"X-API-Key": "${AGENTSPLIT_API_KEY}"',
  )
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page
    .getByRole('button', { name: 'Copy header name', exact: true })
    .click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('X-API-Key')
  await page
    .getByRole('button', { name: 'Copy MCP endpoint', exact: true })
    .click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`${baseURL}/api/mcp`)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page
    .locator('summary')
    .filter({ hasText: 'Detailed agent instructions' })
    .click()
  await page
    .getByRole('button', { name: 'Copy agent instructions', exact: true })
    .click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain(
      'Use the OAuth connection or API key already configured in my client.',
    )
})

test('expense list uses consistent insets and theme surfaces, and search clears accessibly', async ({
  page,
}) => {
  const groupId = await createGroup(page, {
    name: `E2E List ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob'],
  })
  await addExpense(page, groupId, {
    title: 'Grocery check',
    amount: '12',
    paidBy: 'Alice',
    category: 'Groceries',
  })
  for (const width of [320, 488, 1280]) {
    await page.setViewportSize({ width, height: 1000 })
    const search = page.getByRole('textbox', { name: 'Search expenses' })
    const date = page.getByTestId('expense-date-heading').first()
    const row = page.getByTestId('expense-card').first()
    await expect(row).toBeVisible()
    const boxes = await Promise.all([
      search.boundingBox(),
      date.boundingBox(),
      row.boundingBox(),
    ])
    expect(Math.abs(boxes[0]!.x - boxes[1]!.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(boxes[0]!.x - boxes[2]!.x)).toBeLessThanOrEqual(1)
    await row.hover()
    const insets = await row.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const icon = element.querySelector('svg')!.getBoundingClientRect()
      const style = getComputedStyle(element)
      const children = [...element.children]
        .map((child) => child.getBoundingClientRect())
        .filter((rect) => rect.width > 0)
      return {
        left: parseFloat(style.paddingLeft),
        right: parseFloat(style.paddingRight),
        icon: icon.width ? icon.left - bounds.left : null,
        rightContent:
          bounds.right - Math.max(...children.map((rect) => rect.right)),
      }
    })
    expect(insets.left).toBe(12)
    expect(insets.right).toBe(12)
    // Category icons are intentionally hidden in the current mobile row layout.
    if (width < 640) expect(insets.icon).toBeNull()
    else expect(insets.icon).toBeGreaterThanOrEqual(12)
    expect(insets.rightContent).toBeGreaterThanOrEqual(12)
    await expect(date).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
  await page
    .getByRole('textbox', { name: 'Search expenses' })
    .fill('not-a-real-expense')
  await expect(page.getByTestId('expense-card')).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(page.getByTestId('expense-card')).toHaveCount(1)
})
