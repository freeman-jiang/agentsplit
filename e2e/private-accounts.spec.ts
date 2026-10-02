import { createGroup, uniqueSuffix } from './app'
import { expect, test } from './fixtures'

test('account screen creates a key, reveals once, and revokes it', async ({
  page,
}) => {
  await page.goto('/settings')
  await expect(
    page.getByRole('heading', { name: 'Account & agent keys' }),
  ).toBeVisible()
  await page.getByRole('textbox', { name: 'Key name' }).fill('E2E Codex')
  await page
    .getByRole('button', { name: 'Create API key', exact: true })
    .click()
  await expect(
    page.getByText('Copy your new key now. It is shown only once.'),
  ).toBeVisible()
  const secret = await page.locator('code').textContent()
  expect(secret).toMatch(/^agentsplit_/)
  await page.getByRole('button', { name: 'I’ve saved it' }).click()
  await expect(page.getByRole('button', { name: 'Copy API key' })).toHaveCount(
    0,
  )
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Revoke', exact: true }).click()
  await expect(page.getByText('No agent keys yet.')).toBeVisible()
  for (const width of [320, 488, 1280]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
})

test('admin manages invitation through settings without exposing group access', async ({
  page,
}) => {
  const groupId = await createGroup(page, {
    name: `Private UI ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob'],
  })
  await page.goto(`/groups/${groupId}/edit`)
  await page.getByLabel('Invite by Google email').fill('roommate@example.com')
  await page
    .getByRole('button', { name: 'Create invitation', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Copy invitation' }),
  ).toBeVisible()
  await expect(
    page.getByText('roommate@example.com', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Revoke', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Pending invitations' }),
  ).toHaveCount(0)
  for (const width of [320, 488, 1280]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page).toHaveURL(/\/sign-in$/)
  await page.goto(`/groups/${groupId}/expenses`)
  await expect(page).toHaveURL(/\/sign-in$/)
})
