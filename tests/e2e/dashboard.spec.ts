import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  AUTH_STATE,
  expectAccessible,
  SAMPLE_REMOTE,
  SAMPLE_STATE,
  WORKSPACE_NAME,
} from './support';

test.use({ storageState: AUTH_STATE });
test.skip(!SAMPLE_REMOTE, 'Set E2E_GIT_REMOTE to verify the populated dashboard.');

test('dashboard stays focused, accessible and responsive with a connected repository', async ({
  page,
}, info) => {
  const { workspaceId } = JSON.parse(fs.readFileSync(SAMPLE_STATE, 'utf8')) as {
    workspaceId: string;
  };
  await page.goto(`/w/${workspaceId}`);

  await expect(page.getByRole('heading', { level: 1, name: WORKSPACE_NAME })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Workspace summary' })).toBeVisible();
  await expect(page.getByText('Git source states, not container health', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View all activity' })).toHaveAttribute(
    'href',
    `/w/${workspaceId}/settings/activity`,
  );
  await expect(page.getByRole('heading', { name: 'Shortcuts' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Fetch now' })).toBeEnabled();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expectAccessible(page);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/dashboard-${info.project.name}.png`, fullPage: true });
});
