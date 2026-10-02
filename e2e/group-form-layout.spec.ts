import { Page } from '@playwright/test'
import { addExpense, createGroup, openExpense, uniqueSuffix } from './app'
import { expect, test } from './fixtures'
import { selectRadixOption } from './ui'

async function expectUsableGroupFields(page: Page, width: number) {
  const name = page.locator('input[name="name"]')
  const currency = page.getByRole('combobox', {
    name: 'Default currency',
    exact: true,
  })
  await expect(currency).toHaveJSProperty('tagName', 'SELECT')
  const information = page.locator('textarea[name="information"]')
  await expect(name).toBeVisible()
  await expect(currency).toBeVisible()
  const nameBox = (await name.boundingBox())!
  const currencyBox = (await currency.boundingBox())!
  const infoBox = (await information.boundingBox())!
  expect(nameBox.width).toBeGreaterThan(150)
  expect(currencyBox.width).toBeGreaterThan(150)
  if (width < 640) {
    expect(currencyBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height)
    expect(Math.abs(currencyBox.x - nameBox.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(currencyBox.width - nameBox.width)).toBeLessThanOrEqual(1)
  } else {
    expect(currencyBox.x).toBeGreaterThanOrEqual(nameBox.x + nameBox.width)
  }
  expect(infoBox.y).toBeGreaterThanOrEqual(
    Math.max(nameBox.y + nameBox.height, currencyBox.y + currencyBox.height),
  )
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
}

test('group create and settings fields keep their width and never overlap across breakpoints', async ({
  page,
}) => {
  const groupId = await createGroup(page, {
    name: `E2E Layout ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob', 'Carol'],
  })
  for (const route of ['/groups/create', `/groups/${groupId}/edit`]) {
    for (const width of [320, 375, 488, 639, 640, 768, 1280]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto(route)
      await expectUsableGroupFields(page, width)
    }
  }
})

test('changing the default currency leaves existing expenses unchanged', async ({
  page,
}) => {
  const groupId = await createGroup(page, {
    name: `E2E Default currency ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob', 'Carol'],
  })
  await addExpense(page, groupId, {
    title: 'Existing dollars',
    amount: '12',
    paidBy: 'Alice',
  })
  await page.setViewportSize({ width: 488, height: 1000 })
  await page.goto(`/groups/${groupId}/edit`)
  await expectUsableGroupFields(page, 488)
  await expect(
    page.getByText(
      'Changes the default for new expenses only. Existing amounts, currencies and balances stay unchanged.',
    ),
  ).toBeVisible()
  await selectRadixOption(
    page,
    page.getByRole('combobox', { name: 'Default currency', exact: true }),
    /Japanese Yen/,
  )
  await expect(page.locator('[data-vaul-drawer]')).toHaveCount(0)
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes('/api/trpc/groups.update') &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await saved).ok()).toBe(true)
  await page.goto(`/groups/${groupId}/expenses`)
  await openExpense(page, 'Existing dollars')
  await expect(page.locator('input[name="amount"]')).toHaveValue('12')
  await expect(
    page.getByRole('combobox', { name: 'Currency of expense', exact: true }),
  ).toHaveValue('USD')
  await page.goto(`/groups/${groupId}/expenses/create`)
  await expect(
    page.getByRole('combobox', { name: 'Currency of expense', exact: true }),
  ).toHaveValue('JPY')
})
