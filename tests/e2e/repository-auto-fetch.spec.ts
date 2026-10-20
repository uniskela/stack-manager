import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { AUTH_STATE, expectAccessible, SAMPLE_REMOTE, SAMPLE_STATE } from './support';

test.use({ storageState: AUTH_STATE });

test('automatic fetch settings persist, validate and retain edits after failure', async ({
  page,
}, testInfo) => {
  test.skip(!SAMPLE_REMOTE, 'Set E2E_GIT_REMOTE to exercise repository settings.');
  test.skip(
    process.env.STACK_MANAGER_AUTO_FETCH_ENABLED === 'false',
    'Server policy disables automatic fetching.',
  );
  // Desktop and mobile share a repository; isolate policy writes from each other.
  test.skip(
    testInfo.project.name === 'mobile',
    'Policy mutations run once; mobile rendering is covered separately.',
  );
  const { workspaceId, repositoryId } = JSON.parse(fs.readFileSync(SAMPLE_STATE, 'utf8'));
  const url = `/w/${workspaceId}/repositories/${repositoryId}`;
  const endpoint = `**/api/workspaces/${workspaceId}/repositories/${repositoryId}`;
  await page.goto(url);
  const section = page.getByRole('region', { name: 'Automatic fetching' });
  await expect(section.getByText('Automatically checks every 15 minutes.')).toBeVisible();
  await expect(section.getByLabel('Check interval', { exact: true })).toHaveValue('default');
  await section.getByLabel('Check interval', { exact: true }).selectOption('custom');
  const custom = section.getByLabel('Custom interval (minutes)');
  await custom.fill('4');
  await section.getByRole('button', { name: 'Save settings' }).click();
  expect(await custom.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
  await custom.fill('37');
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'PATCH')
      await route.fulfill({ status: 500, json: { error: { message: 'Settings could not be saved.' } } });
    else await route.continue();
  });
  await section.getByRole('button', { name: 'Save settings' }).click();
  await expect(section.getByRole('alert')).toBeVisible();
  await expect(custom).toHaveValue('37');
  await expect(section.getByText('Automatically checks every 15 minutes.')).toBeVisible();
  await page.unroute(endpoint);
  await section.getByRole('button', { name: 'Save settings' }).click();
  await expect(section.getByRole('status')).toHaveText('Automatic fetching settings saved.');
  await expect(section.getByText('Automatically checks every 37 minutes.')).toBeVisible();
  await page.reload();
  await expect(custom).toHaveValue('37');
  const toggle = section.getByRole('checkbox', { name: 'Automatically check for changes' });
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press('Tab');
  await expect(section.getByLabel('Check interval', { exact: true })).toBeFocused();
  await section.getByRole('button', { name: 'Save settings' }).click();
  await expect(section.getByText('Automatic fetching is off for this repository.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fetch now' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Test connection' })).toBeEnabled();
  await expectAccessible(page);
  await section.screenshot({ path: 'test-results/auto-fetch-desktop.png' });
  await toggle.check();
  await section.getByLabel('Check interval', { exact: true }).selectOption('default');
  await section.getByRole('button', { name: 'Save settings' }).click();
  await expect(section.getByText('Automatically checks every 15 minutes.')).toBeVisible();
  await page.reload();
  await expect(section.getByLabel('Check interval', { exact: true })).toHaveValue('default');
});

test('repository policy is accessible and fits the viewport', async ({ page }, testInfo) => {
  test.skip(!SAMPLE_REMOTE, 'Set E2E_GIT_REMOTE to exercise repository settings.');
  const { workspaceId, repositoryId } = JSON.parse(fs.readFileSync(SAMPLE_STATE, 'utf8'));
  await page.goto(`/w/${workspaceId}/repositories/${repositoryId}`);
  await expect(page.getByRole('heading', { name: 'Automatic fetching', exact: true })).toBeVisible();
  await expectAccessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page
    .getByRole('region', { name: 'Automatic fetching' })
    .screenshot({ path: `test-results/auto-fetch-${testInfo.project.name}-layout.png` });
});

test('server-disabled policy is explained while settings and manual actions stay available', async ({
  page,
}, testInfo) => {
  test.skip(
    !SAMPLE_REMOTE || process.env.STACK_MANAGER_AUTO_FETCH_ENABLED !== 'false',
    'Run with STACK_MANAGER_AUTO_FETCH_ENABLED=false and E2E_GIT_REMOTE.',
  );
  test.skip(testInfo.project.name === 'mobile', 'Shared repository mutations run once.');
  const { workspaceId, repositoryId } = JSON.parse(fs.readFileSync(SAMPLE_STATE, 'utf8'));
  await page.goto(`/w/${workspaceId}/repositories/${repositoryId}`);
  const section = page.getByRole('region', { name: 'Automatic fetching' });
  await expect(
    section.getByText(
      'Automatic fetching is disabled by the server administrator. Repository settings are saved but will not take effect until server fetching is enabled.',
    ),
  ).toBeVisible();
  await section.getByLabel('Check interval', { exact: true }).selectOption('30');
  await section.getByRole('button', { name: 'Save settings' }).click();
  await expect(section.getByRole('status')).toBeVisible();
  await page.reload();
  await expect(section.getByLabel('Check interval', { exact: true })).toHaveValue('30');
  await expect(page.getByRole('button', { name: 'Fetch now' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Test connection' })).toBeEnabled();
  await expectAccessible(page);
  await section.screenshot({ path: 'test-results/auto-fetch-server-disabled.png' });
});
