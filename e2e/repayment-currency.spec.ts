import type { Page } from '@playwright/test'
import {
  addExpense,
  createGroup,
  expectBalance,
  expenseCard,
  EXPENSES_URL,
  openExpense,
  openTab,
  reimbursementRow,
  uniqueSuffix,
} from './app'
import { expect, test } from './fixtures'
import { money } from './ui'

async function openRepaymentForm(page: Page) {
  const id = await createGroup(page, {
    name: `Repayment ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob'],
  })
  await addExpense(page, id, { title: 'Hotel', amount: '100', paidBy: 'Alice' })
  await openTab(page, 'Balances')
  await reimbursementRow(page, 'Bob', 'Alice')
    .getByRole('link', { name: 'Mark as paid' })
    .click()
  await page.waitForURL(/\/expenses\/create\?.*reimbursement=yes/)
  return id
}
test('repayment defaults to the amount and currency of the debt', async ({
  page,
}) => {
  await openRepaymentForm(page)
  await expect(page.locator('input[name="amount"]')).toHaveValue('50')
  await expect(
    page.getByRole('combobox', { name: 'Currency of expense' }),
  ).toHaveValue('USD')
  await expect(page.locator('input[name="originalAmount"]')).toHaveCount(0)
})
test('settles a same-currency debt exactly and preserves the payment', async ({
  page,
}) => {
  await openRepaymentForm(page)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForURL(EXPENSES_URL)
  await expect(expenseCard(page, 'Reimbursement')).toContainText(money(50))
  await openTab(page, 'Balances')
  await expectBalance(page, 'Alice', 0)
  await expectBalance(page, 'Bob', 0)
  await openTab(page, 'Expenses')
  await openExpense(page, 'Reimbursement')
  await expect(page.locator('input[name="amount"]')).toHaveValue('50')
  await expect(
    page.getByRole('combobox', { name: 'Currency of expense' }),
  ).toHaveValue('USD')
})
test('changing payment currency keeps face value and never calls an exchange API', async ({
  page,
}) => {
  const requests: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('frankfurter')) requests.push(r.url())
  })
  await openRepaymentForm(page)
  await page
    .getByRole('combobox', { name: 'Currency of expense' })
    .selectOption('EUR')
  await expect(page.locator('input[name="amount"]')).toHaveValue('50')
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true }),
  ).toHaveCount(0)
  expect(requests).toEqual([])
})
