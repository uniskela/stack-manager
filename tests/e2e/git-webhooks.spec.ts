import fs from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { AUTH_STATE, expectAccessible, SAMPLE_REMOTE, SAMPLE_STATE } from './support';

test.use({ storageState: AUTH_STATE });

test('Git webhook settings are accessible and fit desktop and mobile', async ({ page }, info) => {
  // Repository onboarding is optional locally; CI configures the public sample remote.
  test.skip(!SAMPLE_REMOTE, 'Requires the optional sample repository.');
  const { workspaceId, repositoryId } = JSON.parse(fs.readFileSync(SAMPLE_STATE, 'utf8'));
  await page.goto(`/w/${workspaceId}/repositories/${repositoryId}`);
  const region = page.getByRole('region', { name: 'Git webhooks', exact: true });
  await expect(region.getByText(/^(Disabled|Configured \(••••\))$/)).toBeVisible();
  await expect(region.getByRole('button', { name: 'Copy webhook URL' })).toBeVisible();
  await expectAccessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await region.screenshot({ path: `test-results/webhooks-${info.project.name}.png` });
});

test('signing secret saves, rotates with confirmation and disables', async ({ page }, info) => {
  // Repository onboarding is optional locally; CI configures the public sample remote.
  test.skip(!SAMPLE_REMOTE, 'Requires the optional sample repository.');
  // Desktop and mobile share a repository; mutations run once to avoid racing signing changes.
  test.skip(info.project.name !== 'desktop', 'Shared settings mutate once.');
  const { workspaceId, repositoryId } = JSON.parse(fs.readFileSync(SAMPLE_STATE, 'utf8'));
  await page.goto(`/w/${workspaceId}/repositories/${repositoryId}`);
  const region = page.getByRole('region', { name: 'Git webhooks', exact: true });
  try {
    await region
      .getByLabel('Signing secret', { exact: true })
      .fill('synthetic-browser-secret-0123456789abcdef');
    await region.getByRole('button', { name: 'Save signing secret' }).click();
    await expect(region.getByText('Configured (••••)', { exact: true })).toBeVisible();
    await expect(region.getByLabel('New signing secret')).toHaveValue('');
    const repository = (
      await (await page.request.get(`/api/workspaces/${workspaceId}/repositories/${repositoryId}`)).json()
    ).repository;
    const body = JSON.stringify({
      ref: `refs/heads/${repository.defaultBranch}`,
      after: 'b'.repeat(40),
      deleted: false,
      repository: { clone_url: SAMPLE_REMOTE },
    });
    const delivery = randomUUID();
    const send = (key: string, deliveryId = delivery) =>
      page.request.post(`/api/webhooks/git/${workspaceId}/${repositoryId}`, {
        data: body,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': deliveryId,
          'x-hub-signature-256': 'sha256=' + createHmac('sha256', key).update(body).digest('hex'),
        },
      });
    expect((await send('synthetic-browser-secret-0123456789abcdef')).status()).toBe(202);
    expect((await send('synthetic-browser-secret-0123456789abcdef')).status()).toBe(200);
    expect(
      (await (await send('synthetic-browser-secret-0123456789abcdef', randomUUID())).json()).result,
    ).toBe('duplicate');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await region.getByRole('button', { name: 'Copy webhook URL' }).click();
    await expect(region.getByRole('status')).toHaveText('Webhook URL copied.');
    await expect(
      region.getByText(new URL(`/api/webhooks/git/${workspaceId}/${repositoryId}`, page.url()).href, {
        exact: true,
      }),
    ).toBeVisible();
    await region.getByLabel('New signing secret').fill('synthetic-rotated-secret-9876543210abcdef');
    await region.getByRole('button', { name: 'Rotate signing secret…' }).click();
    await expect(region.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await region.getByRole('button', { name: 'Confirm rotation' }).click();
    await expect(region.getByLabel('New signing secret')).toHaveValue('');
    await expect(region.getByRole('status')).toContainText('Signing secret saved.');
    expect((await send('synthetic-browser-secret-0123456789abcdef')).status()).toBe(401);
    expect(
      (await (await send('synthetic-rotated-secret-9876543210abcdef', randomUUID())).json()).result,
    ).toBe('duplicate');
    await expectAccessible(page);
    await region.screenshot({ path: 'test-results/webhooks-configured.png' });
    await region.getByRole('button', { name: 'Disable webhook…' }).click();
    await region.getByRole('button', { name: 'Confirm disable' }).click();
    await expect(region.getByText('Disabled', { exact: true })).toBeVisible();
  } finally {
    const cleanup = await page.request.delete(
      `/api/workspaces/${workspaceId}/repositories/${repositoryId}/webhook`,
      {
        headers: { origin: new URL(page.url()).origin },
      },
    );
    expect(cleanup.ok()).toBe(true);
  }
});
