import {
  addExpense,
  createGroup,
  EXPENSES_URL,
  openExpense,
  openTab,
  paidForRow,
  uniqueSuffix,
} from './app'
import { expect, test } from './fixtures'
import { fillStable, selectRadixOption } from './ui'

async function foreignExpense(
  page: import('@playwright/test').Page,
  groupId: string,
  currency: string,
  amount: string,
  title: string,
) {
  await page.goto(`/groups/${groupId}/expenses/create`)
  await expect(
    page.getByRole('button', { name: 'Create', exact: true }),
  ).toBeVisible()
  await fillStable(page.getByLabel('Description', { exact: true }), title)
  await fillStable(page.getByLabel('Amount', { exact: true }), amount)
  await page
    .getByRole('combobox', { name: 'Currency of expense' })
    .selectOption(currency)
  await selectRadixOption(page, page.getByTestId('paid-by'), 'Alice')
}
test('keeps USD and EUR in separate balances without conversion', async ({
  page,
}) => {
  const id = await createGroup(page, {
    name: `Currencies ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob'],
  })
  await addExpense(page, id, {
    title: 'USD dinner',
    amount: '30',
    paidBy: 'Alice',
  })
  await foreignExpense(page, id, 'EUR', '80', 'EUR hotel')
  await expect(page.locator('input[name="conversionRate"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForURL(EXPENSES_URL)
  await openTab(page, 'Balances')
  await expect(page.locator('main')).toContainText('USD')
  await expect(page.locator('main')).toContainText('EUR')
  const response = await page.request.get(`/groups/${id}/expenses/export/json`)
  const data = await response.json()
  expect(
    data.expenses.map((e: { amount: string; currencyCode: string }) => [
      e.amount,
      e.currencyCode,
    ]),
  ).toEqual(
    expect.arrayContaining([
      ['30', 'USD'],
      ['80', 'EUR'],
    ]),
  )
})
test('JPY uses face-value decimal input and preserves its currency', async ({
  page,
}) => {
  const id = await createGroup(page, {
    name: `JPY ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob'],
  })
  await foreignExpense(page, id, 'JPY', '6000', 'Tokyo dinner')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForURL(EXPENSES_URL)
  await openExpense(page, 'Tokyo dinner')
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('6000')
  await expect(
    page.getByRole('combobox', { name: 'Currency of expense' }),
  ).toHaveValue('JPY')
})
test('unequal currency shares survive editing without conversion', async ({
  page,
}) => {
  const id = await createGroup(page, {
    name: `Exact shares ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob'],
  })
  await foreignExpense(page, id, 'EUR', '80', 'Lisbon tickets')
  await selectRadixOption(page, page.getByTestId('split-mode'), /By amount/)
  await fillStable(paidForRow(page, 'Alice').getByRole('textbox').last(), '50')
  await fillStable(paidForRow(page, 'Bob').getByRole('textbox').last(), '30')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForURL(EXPENSES_URL)
  await openExpense(page, 'Lisbon tickets')
  await expect(
    paidForRow(page, 'Alice').getByRole('textbox').last(),
  ).toHaveValue('50')
  await expect(paidForRow(page, 'Bob').getByRole('textbox').last()).toHaveValue(
    '30',
  )
})
test('CSV exports face-value amounts and their own currencies', async ({
  page,
}) => {
  const id = await createGroup(page, {
    name: `Currency export ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob'],
  })
  await foreignExpense(page, id, 'EUR', '80', 'Rome dinner')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForURL(EXPENSES_URL)
  const response = await page.request.get(`/groups/${id}/expenses/export/csv`)
  expect(response.status()).toBe(200)
  const csv = await response.text()
  expect(csv).toContain('Rome dinner')
  expect(csv).toContain('EUR')
  expect(csv).toContain('80.00')
  expect(csv).not.toContain('1.25')
})
