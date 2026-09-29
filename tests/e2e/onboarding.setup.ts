import fs from 'node:fs';
import path from 'node:path';
import { expect, test as setup } from '@playwright/test';
import { ADMIN, AUTH_STATE, expectAccessible, SAMPLE_REMOTE, SAMPLE_STATE, WORKSPACE_NAME } from './support';

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

/** Connects SAMPLE_REMOTE and registers its root as a stack, for the source workspace specs. */
setup('sample repository and stack', async ({ browser }) => {
  setup.skip(!SAMPLE_REMOTE, 'Set E2E_GIT_REMOTE to a public HTTPS repository with a root compose file.');
  setup.setTimeout(180_000);
  const context = await browser.newContext({ storageState: AUTH_STATE });
  const page = await context.newPage();
  await page.goto('/');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const headers = { Origin: new URL(page.url()).origin };
  const created = await page.request.post(`/api/workspaces/${workspaceId}/repositories`, {
    headers,
    data: { gitProviderType: 'github', remoteUrl: SAMPLE_REMOTE, auth: { type: 'none' } },
  });
  expect(created.status(), await created.text()).toBe(201);
  const repositoryId = (await created.json()).repository.id as string;
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/workspaces/${workspaceId}/repositories/${repositoryId}`)).json())
          .repository.syncStatus,
      { timeout: 150_000, intervals: [1000] },
    )
    .toBe('ready');
  const stack = await page.request.post(
    `/api/workspaces/${workspaceId}/repositories/${repositoryId}/stacks`,
    {
      headers,
      data: { rootPath: '', name: 'Sample' },
    },
  );
  expect(stack.status(), await stack.text()).toBe(201);
  fs.mkdirSync(path.dirname(SAMPLE_STATE), { recursive: true });
  fs.writeFileSync(SAMPLE_STATE, JSON.stringify({ workspaceId, stackId: (await stack.json()).stack.id }));
  await context.close();
});
