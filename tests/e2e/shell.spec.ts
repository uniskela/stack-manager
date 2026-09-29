import { expect, test, type Page } from '@playwright/test';
import { ADMIN, AUTH_STATE, expectAccessible, WORKSPACE_NAME } from './support';

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 860;

/** On narrow screens navigation lives in a drawer; open it first. */
async function openNav(page: Page) {
  if (!isMobile(page)) return page.getByRole('complementary', { name: 'Sidebar' });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe('signed in', () => {
  test.use({ storageState: AUTH_STATE });

  test('workspace home: empty state, navigation and accessibility', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Connect your Compose repository' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'stack-manager home' }).first()).toBeVisible();
    await expectAccessible(page);

    const nav = await openNav(page);
    await expect(nav.getByText(WORKSPACE_NAME)).toBeVisible();
    await expect(nav.getByText(ADMIN.username)).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Repositories' })).toHaveAttribute('aria-current', 'page');
    if (isMobile(page)) await expectAccessible(page);

    await nav.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeHidden();
    await expectAccessible(page);
  });

  test('connect repository: breadcrumbs and server-side validation', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Connect repository' }).click();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Repositories');
    await expectAccessible(page);

    await page.getByLabel('HTTPS clone URL').fill('http://git.example.com/me/stacks.git');
    await page.getByRole('textbox', { name: 'Access token' }).fill('not-a-real-token');
    await page.getByRole('button', { name: 'Connect repository' }).click();
    await expect(page.getByText('Only https:// remotes are supported', { exact: false })).toBeVisible();
    await expect(page.getByLabel('HTTPS clone URL')).toHaveAttribute('aria-invalid', 'true');
    await expectAccessible(page);
  });

  test('unknown pages stay inside the workspace shell', async ({ page }) => {
    await page.goto('/');
    const home = new URL(page.url()).pathname;
    await page.goto(`${home}/repositories/does-not-exist`);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    if (!isMobile(page)) await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
    else await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('link', { name: 'Back to repositories' }).click();
    await expect(page).toHaveURL(new RegExp(`${home}$`));
  });
});

test('sign in and sign out', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await expectAccessible(page);
  await page.getByLabel('Username').fill(ADMIN.username);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/w\//);

  const nav = await openNav(page);
  await nav.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
});
