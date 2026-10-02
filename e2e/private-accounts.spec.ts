import { createGroup, uniqueSuffix } from './app'
import { seedAccount, setTestAccountName } from './auth'
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
  await page
    .getByLabel('Participant', { exact: true })
    .selectOption({ label: 'Bob' })
  await page.getByLabel('Invite by Google email').fill('roommate@example.com')
  await page
    .getByRole('button', { name: 'Create invitation', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Copy invitation' }),
  ).toBeVisible()
  await expect(
    page.getByText('roommate@example.com · Bob', { exact: true }),
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

test('invitation binds the intended account on a second browser, with no identity picker', async ({
  page,
  browser,
  baseURL,
}) => {
  const groupId = await createGroup(page, {
    name: `Invite acceptance ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob'],
  })
  const context = await browser.newContext({ baseURL, locale: 'en-US' })
  try {
    const bob = await seedAccount(context, baseURL!)
    await setTestAccountName(context, 'Bob')
    await page.goto(`/groups/${groupId}/edit`)
    await page
      .getByLabel('Participant', { exact: true })
      .selectOption({ label: 'Bob' })
    await page.getByLabel('Invite by Google email').fill(bob.email)
    await page
      .getByRole('button', { name: 'Create invitation', exact: true })
      .click()
    const link = await page.locator('#members code').innerText()
    await page.goto(link)
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'unavailable for this account',
    )
    await expect(
      page.getByRole('button', { name: 'Accept invitation' }),
    ).toHaveCount(0)
    const roommate = await context.newPage()
    await roommate.goto(link)
    await expect(
      roommate.getByText('This is your fixed participant identity.', {
        exact: false,
      }),
    ).toContainText('Bob')
    await roommate.getByRole('button', { name: 'Accept invitation' }).click()
    await roommate.waitForURL(`/groups/${groupId}/expenses`)
    await expect(roommate.getByRole('dialog')).toHaveCount(0)
    await roommate.goto(`/groups/${groupId}/expenses/create`)
    await expect(roommate.getByTestId('paid-by')).toContainText('Bob')
    await roommate.goto(`/groups/${groupId}/edit`)
    await expect(
      roommate.getByText('Participant: Bob', { exact: true }),
    ).toBeVisible()
    await expect(
      roommate.getByRole('button', { name: 'Link identity' }),
    ).toHaveCount(0)
  } finally {
    await context.close()
  }
})
