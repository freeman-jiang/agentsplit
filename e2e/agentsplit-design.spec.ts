import {
  addExpense,
  createGroup,
  EXPENSES_URL,
  openExpense,
  uniqueSuffix,
} from './app'
import { expect, test } from './fixtures'
import { fillStable, selectRadixOption } from './ui'

test('optional details survive editing when collapsed, with accessible split controls', async ({
  page,
}) => {
  const groupId = await createGroup(page, {
    name: `E2E Design ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob', 'Carol'],
  })
  await addExpense(page, groupId, {
    title: 'Household groceries',
    amount: '12',
    paidBy: 'Alice',
  })
  await openExpense(page, 'Household groceries')
  await expect(page.getByTestId('split-mode')).toBeVisible()
  await fillStable(page.locator('input[name="amount"]'), 'bad')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.locator('input[name="amount"]')).toHaveAttribute(
    'aria-invalid',
    'true',
  )
  await expect(
    page.getByText('Enter a decimal amount such as 12.34'),
  ).toBeVisible()
  const amountBox = await page.locator('input[name="amount"]').boundingBox()
  const currencyBox = await page
    .getByRole('combobox', { name: 'Currency of expense', exact: true })
    .boundingBox()
  expect(Math.abs(amountBox!.y - currencyBox!.y)).toBeLessThanOrEqual(2)
  await fillStable(page.locator('input[name="amount"]'), '12')

  const notes = page.locator('details').filter({
    has: page.locator('summary').filter({ hasText: 'Notes & receipts' }),
  })
  await notes.locator('summary').click()
  await fillStable(
    page.locator('textarea[name="notes"]'),
    'Keep this receipt note',
  )
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await page.waitForURL(EXPENSES_URL)
  await openExpense(page, 'Household groceries')
  await expect(page.locator('textarea[name="notes"]')).toBeVisible()
  await expect(page.locator('textarea[name="notes"]')).toHaveValue(
    'Keep this receipt note',
  )
  await notes.locator('summary').click()
  await fillStable(page.locator('input[name="amount"]'), '15')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await page.waitForURL(EXPENSES_URL)
  await openExpense(page, 'Household groceries')
  await expect(page.locator('textarea[name="notes"]')).toHaveValue(
    'Keep this receipt note',
  )
  await expect(page.getByTestId('share-preview').first()).toContainText('$5.00')
  const gap = await page.getByTestId('paid-by').evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const icon = el.querySelector('svg')!.getBoundingClientRect()
    return rect.right - icon.right
  })
  expect(gap).toBeGreaterThanOrEqual(10)
  await expect(page).toHaveTitle(/AgentSplit/)
})

test('mobile currency selection and saving preserve face-value money without overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 })
  const groupId = await createGroup(page, {
    name: `E2E Mobile ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob', 'Carol'],
  })
  await addExpense(page, groupId, {
    title: 'Mobile expense',
    amount: '6000',
    paidBy: 'Alice',
  })
  await openExpense(page, 'Mobile expense')
  await selectRadixOption(
    page,
    page.getByRole('combobox', { name: 'Currency of expense', exact: true }),
    /Japanese Yen/,
  )
  await expect(page.locator('input[name="amount"]')).toHaveValue('6000')
  await expect(page.getByTestId('share-preview').first()).toContainText('2,000')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await page.waitForURL(EXPENSES_URL)
  await openExpense(page, 'Mobile expense')
  await expect(
    page.getByRole('combobox', { name: 'Currency of expense', exact: true }),
  ).toHaveValue('JPY')
  await expect(page.locator('input[name="amount"]')).toHaveValue('6000')
  await expect(page.locator('body')).not.toContainText('Application error')
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  await page.locator('summary').filter({ hasText: 'More options' }).click()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
})
