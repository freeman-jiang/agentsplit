import { expect, test } from './fixtures'

test.describe('Signed-out entry', () => {
  test.use({ authenticated: false })
  test('landing has one Log In action and no account or workspace controls', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(
      page.getByRole('button', { name: 'Log In', exact: true }),
    ).toBeVisible()
    await expect(page.locator('main').getByRole('button')).toHaveCount(1)
    await expect(page.locator('main').getByRole('link')).toHaveCount(0)
    await expect(
      page.getByRole('navigation', { name: 'Workspace' }),
    ).toHaveCount(0)
    await expect(
      page.getByRole('link', { name: 'Profile and settings' }),
    ).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'Toggle theme' }),
    ).toHaveCount(0)
    for (const width of [320, 488, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
    }
    let provider = '',
      callback = ''
    await page.route('**/api/auth/sign-in/social', async (route) => {
      const body = route.request().postDataJSON()
      provider = body.provider
      callback = body.callbackURL
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Test sign-in error' }),
      })
    })
    await page.getByRole('button', { name: 'Log In', exact: true }).click()
    await expect(page.locator('main').getByRole('alert')).toContainText(
      'Test sign-in error',
    )
    expect(provider).toBe('google')
    expect(callback).toBe('/')
  })
  test('agent setup requires login and invitation destinations survive the login button', async ({
    page,
  }) => {
    await page.goto('/agents')
    await expect(page).toHaveURL(/\/sign-in$/)
    const next = '/invite/' + 'a'.repeat(43)
    await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
    await expect(
      page.getByRole('heading', { name: 'You’ve been invited to AgentSplit' }),
    ).toBeVisible()
    await expect(
      page.getByText(
        'If you’re new, we’ll create your account automatically.',
        { exact: false },
      ),
    ).toBeVisible()
    let callback = ''
    let prompt = ''
    await page.route('**/api/auth/sign-in/social', async (route) => {
      callback = route.request().postDataJSON().callbackURL
      prompt = route.request().postDataJSON().additionalParams?.prompt
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Test sign-in error' }),
      })
    })
    await page
      .getByRole('button', { name: 'Continue with Google', exact: true })
      .click()
    await expect(page.locator('main').getByRole('alert')).toBeVisible()
    expect(callback).toBe(next)
    expect(prompt).toBe('select_account')
  })
})

test('profile avatar opens settings and theme preferences work outside the header', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/$/)
  const avatar = page.getByRole('link', {
    name: 'Profile and settings',
    exact: true,
  })
  await expect(avatar).toHaveText('EO')
  await expect(avatar).toHaveAttribute('href', '/settings')
  await expect(
    page.locator('header').getByRole('button', { name: 'Toggle theme' }),
  ).toHaveCount(0)
  await avatar.click()
  await expect(page).toHaveURL(/\/settings$/)
  await page.getByLabel('Theme', { exact: true }).selectOption('dark')
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.reload()
  await expect(page.getByLabel('Theme', { exact: true })).toHaveValue('dark')
  await page.getByLabel('Theme', { exact: true }).selectOption('light')
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  for (const width of [320, 488, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    const box = await avatar.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x + box!.width).toBeGreaterThan(width - 40)
    expect(box!.y).toBeLessThan(30)
  }
})
