import { expect, test, type Page } from '@playwright/test'
import { seedHousehold } from './fixtures'

/** Opens the private expense form for the signed-in owner and one invited guest. */
async function startPrivateExpense(page: Page) {
  await page.goto('/expenses/create')
  await page.getByText('Invite someone new by email').click()
  await page.getByLabel('Name', { exact: true }).fill('Dana Guest')
  await page.getByLabel('Email', { exact: true }).fill(`dana-${Date.now()}@example.com`)
  await page.getByRole('button', { name: 'Add person' }).click()
  await page.getByRole('button', { name: 'Continue to expense' }).click()
  await expect(page.getByRole('heading', { name: 'Add expense' })).toBeVisible()
  await page.getByLabel('Description').fill('Concert tickets')
  await page.getByLabel('Amount', { exact: true }).fill('30.00')
}

test('an ungrouped expense uses the full expense form with the private options, and its edit page opens the full form (P-UNGROUP-14, P-UNGROUP-15, P-UNGROUP-66, P-UNGROUP-67)', async ({ page, context, baseURL }) => {
  await seedHousehold(context, baseURL ?? '')
  await startPrivateExpense(page)

  // The live share preview of the full form: 30.00 evenly between two people.
  await expect(page.getByTestId('share-preview')).toHaveText(['$15.00', '$15.00'])
  // v1's privateExpense options.
  await expect(page.getByLabel('Expense Recurrence')).toBeDisabled()
  await expect(page.getByLabel('This is a payment')).toHaveCount(0)
  await expect(page.getByLabel('Save as default splitting options')).toHaveCount(0)
  await expect(page.getByText('Receipts', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Expense total')).toContainText('Edits stay in this expense’s private log.')

  // Every person stays involved: Dana neither pays nor shares, so the form refuses the save.
  await page.getByLabel('Dana Guest').uncheck()
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText(/Include yourself and exactly the people paying for or sharing this expense/)).toBeVisible()
  await page.getByLabel('Dana Guest').check()

  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('heading', { name: 'Expense saved' })).toBeVisible()
  await page.getByRole('link', { name: 'View expense' }).click()
  await expect(page).toHaveURL(/\/expenses\/[A-Za-z0-9_-]{21}$/)
  const editUrl = page.url()

  // The edit page opens the same full form, with its preview, private options and log.
  await expect(page.getByRole('heading', { name: 'Edit expense' })).toBeVisible()
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('30.00')
  await expect(page.getByTestId('share-preview')).toHaveText(['$15.00', '$15.00'])
  await expect(page.getByLabel('Expense Recurrence')).toBeDisabled()
  await expect(page.getByLabel('Expense total')).toContainText('Edits stay in this expense’s private log.')
  await expect(page.getByTestId('expense-log')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Payments for this expense' })).toContainText('Dana Guest owes Alice Example')

  await page.getByLabel('Amount', { exact: true }).fill('40.00')
  await expect(page.getByTestId('share-preview')).toHaveText(['$20.00', '$20.00'])
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.goto(editUrl)
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('40.00')

  // A repayment uses the full payment form, prefilled from the suggestion, and returns to the expense (P-UNGROUP-72).
  // The suggestion's link carries the amount; the section's own Record payment link does not.
  await page.locator('a[href*="amount="]', { hasText: 'Record payment' }).click()
  await expect(page.getByRole('heading', { name: 'Record payment' })).toBeVisible()
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('20.00')
  await page.getByRole('button', { name: 'Record payment' }).click()
  await expect(page).toHaveURL(editUrl)
  await expect(page.getByRole('region', { name: 'Payments for this expense' })).toContainText('Settled in USD.')
})

test('a private create whose response is lost opens the saved expense instead of failing (P-UNGROUP-19)', async ({ page, context, baseURL }) => {
  await seedHousehold(context, baseURL ?? '')
  await startPrivateExpense(page)
  // The server saves the expense, but the browser never gets the answer.
  await page.route('**/api/rpc', async (route) => {
    if (!route.request().postData()?.includes('"expenses.createUngrouped"')) return route.continue()
    await route.fetch()
    await route.fulfill({ status: 500, body: 'lost response' })
  })
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(/\/expenses\/[A-Za-z0-9_-]{21}$/)
  await expect(page.getByRole('heading', { name: 'Edit expense' })).toBeVisible()
  await expect(page.getByLabel('Description')).toHaveValue('Concert tickets')
})

test('the ID of a private context opens its expense, not a group page (P-UNGROUP-39, P-GROUP-47, P-HIST-63)', async ({ page, context, baseURL }) => {
  await seedHousehold(context, baseURL ?? '')
  await startPrivateExpense(page)
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('link', { name: 'View expense' }).click()
  await expect(page).toHaveURL(/\/expenses\/[A-Za-z0-9_-]{21}$/)
  const expenseUrl = page.url()
  const id = new URL(expenseUrl).pathname.split('/').at(-1) ?? ''
  for (const path of [`/${id}`, `/${id}/activity`, `/groups/${id}/edit`]) {
    await page.goto(path)
    await expect(page).toHaveURL(expenseUrl)
    await expect(page.getByRole('heading', { name: 'Edit expense' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Group' })).toHaveCount(0)
  }
})
