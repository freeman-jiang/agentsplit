import { z } from 'zod'
import { addExpense, createGroup, uniqueSuffix } from './app'
import { expect, test } from './fixtures'

test('expense log is lazy, isolated and paginated without losing history during new edits', async ({
  page,
  baseURL,
}, testInfo) => {
  const id = await createGroup(page, {
    name: `Log ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob'],
  })
  await addExpense(page, id, {
    title: 'Shared towels',
    amount: '20',
    paidBy: 'Alice',
  })
  const expenseId = await page
    .getByTestId('expense-card')
    .getAttribute('data-expense-id')
  expect(expenseId).toBeTruthy()
  await addExpense(page, id, {
    title: 'Unrelated dinner',
    amount: '30',
    paidBy: 'Bob',
  })
  let revision = 1
  const edit = async () => {
    const response = await page.request.post(
      '/api/trpc/groups.expenses.update',
      {
        headers: { origin: baseURL! },
        data: {
          json: {
            groupId: id,
            expenseId,
            expectedRevision: revision,
            expenseFormValues: { notes: `Revision ${revision + 1}` },
          },
        },
      },
    )
    expect(response.ok()).toBe(true)
    const body = z
      .object({
        result: z.object({
          data: z.object({ json: z.object({ revision: z.number() }) }),
        }),
      })
      .parse(await response.json())
    revision = body.result.data.json.revision
  }
  for (let i = 0; i < 21; i++) await edit()
  await page.goto(`/groups/${id}/expenses`)
  const card = page
    .getByTestId('expense-card')
    .filter({ hasText: 'Shared towels' })
  await expect(card.getByTestId('expense-metadata')).toHaveText(
    'Last edited by Alice',
  )
  await expect(
    card.getByTestId('expense-metadata').locator('time'),
  ).toHaveCount(0)
  await card.click()
  await page.waitForURL(new RegExp(`/expenses/${expenseId}/edit$`))
  await expect(
    page.getByRole('heading', { name: 'Edit expense', exact: true }),
  ).toBeVisible()
  await expect(page.getByTestId('expense-metadata')).toContainText(
    'Your last edit',
  )
  await expect(page.getByTestId('expense-log-entry')).toHaveCount(0)
  const log = page.getByTestId('expense-log')
  await log.locator('summary').first().click()
  await expect(page.getByTestId('expense-log-entry')).toHaveCount(20)
  await edit()
  await page.getByRole('button', { name: 'Load older entries' }).click()
  await expect(page.getByTestId('expense-log-entry')).toHaveCount(22)
  await expect(page.getByTestId('expense-log-entry').last()).toContainText(
    'Added by Alice',
  )
  await expect(
    page.getByRole('button', { name: 'Load older entries' }),
  ).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/expenses/${expenseId}/edit$`))
  await page.getByTestId('expense-log-entry').first().locator('summary').click()
  await expect(log).toContainText('Revision 22')
  await expect(log).not.toContainText('Unrelated dinner')
  await page.screenshot({
    path: testInfo.outputPath('expense-log.png'),
    fullPage: true,
  })
  await page.setViewportSize({ width: 375, height: 1000 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.getByRole('tab', { name: 'Log', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Log', exact: true }),
  ).toBeVisible()
})
