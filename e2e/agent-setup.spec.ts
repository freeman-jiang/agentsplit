import { addExpense, createGroup, uniqueSuffix } from './app'
import { expect, test } from './fixtures'

test('landing page offers groups or agent setup with usable connection instructions', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 320, height: 1000 })
  await page.goto('/')
  const main = page.locator('main')
  await expect(main.getByRole('link')).toHaveCount(2)
  await expect(
    main.getByRole('link', { name: 'Go to groups' }),
  ).toHaveAttribute('href', '/groups')
  await expect(page.locator('a[href*="github.com"]')).toHaveCount(0)
  await main.getByRole('link', { name: 'Set up an agent' }).click()
  await expect(
    page.getByRole('heading', { name: 'Set up your agent' }),
  ).toBeVisible()
  await expect(
    page.getByText(/there is no self-service key screen/),
  ).toBeVisible()
  await expect(
    page.getByText(`${baseURL}/api/mcp`, { exact: true }),
  ).toBeVisible()
  await expect(page.locator('pre').first()).toContainText(
    'bearer_token_env_var = "AGENTSPLIT_MCP_TOKEN"',
  )
  await expect(page.locator('pre').nth(1)).toContainText(
    'Bearer ${AGENTSPLIT_MCP_TOKEN}',
  )
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
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
        icon: icon.left - bounds.left,
        rightContent:
          bounds.right - Math.max(...children.map((rect) => rect.right)),
      }
    })
    expect(insets.left).toBe(12)
    expect(insets.right).toBe(12)
    expect(insets.icon).toBeGreaterThanOrEqual(12)
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
