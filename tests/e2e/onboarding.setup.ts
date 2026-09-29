import { expect, test as setup } from '@playwright/test';
import { ADMIN, AUTH_STATE, expectAccessible, WORKSPACE_NAME } from './support';

setup('first run: admin account → workspace → skip repository', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Create the admin account' })).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel('Admin username').fill(ADMIN.username);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByLabel('Confirm password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Create admin account' }).click();

  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole('heading', { name: 'Name your workspace' })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel('Workspace name').fill(WORKSPACE_NAME);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page).toHaveURL(/\/repositories\/new\?onboarding=1$/);
  await expect(page.getByRole('heading', { name: 'Connect a repository' })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('link', { name: 'Skip for now' }).click();

  await expect(page.getByRole('heading', { name: 'Connect your Compose repository' })).toBeVisible();
  await page.context().storageState({ path: AUTH_STATE });
});
