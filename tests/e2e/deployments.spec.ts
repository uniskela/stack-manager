import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { AUTH_STATE, expectAccessible, SAMPLE_REMOTE, SAMPLE_STATE } from './support';

test.use({ storageState: AUTH_STATE });

test('deployment settings and confirmation are accessible on desktop and mobile', async ({ page }, info) => {
  test.skip(!SAMPLE_REMOTE, 'Requires the optional sample repository.');
  const { workspaceId, stackId } = JSON.parse(fs.readFileSync(SAMPLE_STATE, 'utf8'));
  const endpoint = `/api/workspaces/${workspaceId}/stacks/${stackId}/deployment`;
  // Browser-only fixture: real outbound transport is covered by local mock-server integration tests.
  let binding: object | null = null;
  let revision = 0;
  let triggers = 0;
  let failSave = true;
  const attempts: object[] = [];
  await page.route(`**${endpoint}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/history')) return route.fulfill({ json: { attempts } });
    if (path.endsWith('/trigger')) {
      triggers++;
      const attempt = {
        id: 'attempt',
        providerType: 'generic-webhook',
        requestedAt: new Date().toISOString(),
        status: 'accepted',
        httpStatus: 202,
        failureReason: null,
      };
      attempts.unshift(attempt);
      return route.fulfill({ json: { attempt } });
    }
    if (request.method() === 'DELETE') binding = null;
    if (request.method() === 'PUT') {
      if (failSave) {
        failSave = false;
        return route.fulfill({
          status: 409,
          json: { error: { code: 'conflict', message: 'Synthetic recoverable save failure.' } },
        });
      }
      const body = request.postDataJSON();
      binding = {
        id: 'binding',
        providerType: body.providerType,
        enabled: body.enabled,
        deployOnPush: false,
        revision: String(++revision),
        hint: '••••',
      };
    }
    return route.fulfill({ json: { binding } });
  });
  await page.goto(`/w/${workspaceId}/stacks/${stackId}/deployment`);
  const section = page.getByRole('region', { name: 'Deployment', exact: true });
  await expect(section.getByRole('button', { name: 'Deploy now', exact: true })).toBeDisabled();
  await section
    .getByLabel('Webhook URL', { exact: true })
    .fill('https://portainer.example/api/stacks/webhooks/synthetic');
  await section.getByRole('button', { name: 'Save binding' }).click();
  await expect(section.getByRole('alert')).toHaveText('Synthetic recoverable save failure.');
  await expect(section.getByLabel('Webhook URL', { exact: true })).toHaveValue(
    'https://portainer.example/api/stacks/webhooks/synthetic',
  );
  await section.getByRole('button', { name: 'Save binding' }).click();
  await expect(section.getByLabel('Replacement webhook URL')).toHaveValue('');
  await expect(section.getByText('Configured (••••)', { exact: true })).toBeVisible();
  await section.getByLabel('Provider', { exact: true }).selectOption('generic-webhook');
  await section.getByLabel('Replacement webhook URL').fill('https://generic.example/deploy');
  await section.getByLabel('Bearer token (optional)').fill('synthetic-browser-token');
  await section.getByRole('button', { name: 'Save binding' }).click();
  await expect(section.getByLabel('Bearer token (optional)')).toHaveValue('');
  await section.getByRole('button', { name: 'Deploy now', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm deployment request' });
  await expect(dialog).toContainText('Sample');
  await expect(dialog).toContainText('Generic HTTP webhook');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  expect(triggers).toBe(0);
  await section.getByRole('button', { name: 'Deploy now', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'Send deployment request' })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(section.getByText('Accepted', { exact: true })).toBeVisible();
  expect(triggers).toBe(1);
  await section.getByLabel('Binding enabled').uncheck();
  await section.getByRole('button', { name: 'Save binding' }).click();
  await expect(section.getByRole('button', { name: 'Deploy now', exact: true })).toBeDisabled();
  await expectAccessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await section.screenshot({ path: `test-results/deployment-${info.project.name}.png` });
  await section.getByRole('button', { name: 'Remove binding…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove binding', exact: true }).click();
  await expect(section.getByText('Not configured', { exact: true })).toBeVisible();
});
