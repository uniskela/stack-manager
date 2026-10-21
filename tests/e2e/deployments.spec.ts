import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { AUTH_STATE, expectAccessible, SAMPLE_REMOTE, SAMPLE_STATE } from './support';

test.use({ storageState: AUTH_STATE });

test('deployment settings and confirmation are accessible on desktop and mobile', async ({ page }, info) => {
  // Local runs may omit repository onboarding; CI always provides the public sample repository.
  test.skip(!SAMPLE_REMOTE, 'Requires the optional sample repository.');
  const { workspaceId, stackId } = JSON.parse(fs.readFileSync(SAMPLE_STATE, 'utf8'));
  const endpoint = `/api/workspaces/${workspaceId}/stacks/${stackId}/deployment`;
  // Browser-only fixture: real outbound transport is covered by local mock-server integration tests.
  let binding: object | null = null;
  let revision = 0;
  let triggers = 0;
  let validations = 0;
  let previews = 0;
  let saves = 0;
  let failSave = true;
  let changeDuringValidation = false;
  const attempts: object[] = [];
  const decisions = [
    {
      id: 'decision',
      decision: 'skip',
      explanation: 'No deployment required. No changed paths match the routing policy.',
      reasonCode: 'no_relevant_changes',
      createdAt: new Date().toISOString(),
      beforeSha: 'a'.repeat(40),
      afterSha: 'b'.repeat(40),
      attemptId: null,
      matchedPaths: [],
    },
  ];
  await page.route(`**${endpoint}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/history')) return route.fulfill({ json: { attempts, decisions } });
    if (path.endsWith('/preview')) {
      previews++;
      const body = request.postDataJSON();
      expect(body.routingPolicy.include).toContain('config/**');
      expect(body.paths).toEqual(['apps/sample/config/service.yml']);
      return route.fulfill({
        json: {
          decision: {
            relevant: true,
            deployEligible: false,
            matchedPaths: body.paths,
            reasonCode: 'deploy_on_push_disabled',
            explanation: 'Relevant paths changed, but deploy on push is disabled.',
          },
        },
      });
    }
    if (path.endsWith('/test')) {
      validations++;
      if (changeDuringValidation) binding = { ...binding, revision: String(++revision), enabled: false };
      binding = {
        ...binding,
        lastTestedAt: new Date().toISOString(),
        lastTestStatus: 'ok',
        lastTestMessage: 'Saved destination satisfies DNS/network policy.',
        automationHold: validations > 1,
      };
      return route.fulfill({ json: { binding } });
    }
    if (path.endsWith('/trigger')) {
      triggers++;
      const attempt = {
        id: 'attempt',
        providerType: 'generic-webhook',
        requestedAt: new Date().toISOString(),
        triggerType: 'manual',
        status: 'accepted',
        httpStatus: 202,
        failureReason: null,
      };
      attempts.unshift(attempt);
      return route.fulfill({ json: { attempt: { ...attempt, status: 'queued' } } });
    }
    if (request.method() === 'DELETE') binding = null;
    if (request.method() === 'PUT') {
      saves++;
      if (failSave) {
        failSave = false;
        return route.fulfill({
          status: 409,
          json: { error: { code: 'conflict', message: 'Synthetic recoverable save failure.' } },
        });
      }
      const body = request.postDataJSON();
      expect(body.deployOnPush).toBe(false);
      if (binding && body.expectedRevision !== String(revision)) {
        return route.fulfill({
          status: 409,
          json: { error: { code: 'conflict', message: 'Settings changed in another tab.' } },
        });
      }
      binding = {
        id: 'binding',
        providerType: body.providerType,
        enabled: body.enabled,
        deployOnPush: body.deployOnPush,
        routingPolicy: body.routingPolicy,
        routingHeadSha: null,
        automationHold: false,
        revision: String(++revision),
        hint: '••••',
      };
    }
    return route.fulfill({ json: { binding } });
  });
  await page.goto(`/w/${workspaceId}/stacks/${stackId}/deployment`);
  const section = page.getByRole('region', { name: 'Deployment', exact: true });
  await expect(section.getByRole('button', { name: 'Deploy now', exact: true })).toBeDisabled();
  const automatic = section.getByLabel('Deploy automatically after verified Git pushes');
  await expect(automatic).not.toBeChecked();
  const includes = section.getByLabel('Include patterns', { exact: true });
  const defaultIncludes = await includes.inputValue();
  await includes.fill('../outside/**');
  await section.getByRole('button', { name: 'Preview routing' }).click();
  await expect(section.getByRole('alert')).toHaveText(
    'Routing policy include contains an invalid or unsupported glob.',
  );
  await expect(includes).toHaveAttribute('aria-invalid', 'true');
  expect(previews).toBe(0);
  await expectAccessible(page);
  await includes.fill(defaultIncludes);
  await section.getByLabel('Sample changed paths').fill('apps/sample/config/service.yml');
  await section.getByRole('button', { name: 'Preview routing' }).click();
  await expect(
    section.getByText('Relevant paths changed, but deploy on push is disabled.', { exact: true }),
  ).toBeVisible();
  expect(previews).toBe(1);
  expect(triggers).toBe(0);
  await expect(automatic).not.toBeChecked();
  await expectAccessible(page);
  await section
    .getByLabel('Webhook URL', { exact: true })
    .fill('https://portainer.example/api/stacks/webhooks/synthetic');
  await includes.fill('/absolute/**');
  await section.getByRole('button', { name: 'Save binding' }).click();
  await expect(section.getByRole('alert')).toHaveText(
    'Routing policy include contains an invalid or unsupported glob.',
  );
  expect(saves).toBe(0);
  await includes.fill(defaultIncludes);
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
  await section.getByLabel('Replacement webhook URL').fill('https://unsaved.example/deploy');
  await section.getByLabel('Bearer token (optional)').fill('synthetic-unsaved-token');
  const validateButton = section.getByRole('button', { name: 'Validate destination', exact: true });
  await validateButton.focus();
  await page.keyboard.press('Enter');
  await expect(section.getByText('Destination validation: Passed', { exact: true })).toBeVisible();
  expect(validations).toBe(1);
  expect(triggers).toBe(0);
  await expect(section.getByLabel('Replacement webhook URL')).toHaveValue('https://unsaved.example/deploy');
  await expect(section.getByLabel('Bearer token (optional)')).toHaveValue('synthetic-unsaved-token');
  await section.getByLabel('Replacement webhook URL').fill('');
  await section.getByLabel('Bearer token (optional)').fill('');
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
  await expect(section.getByText(/Manual · Generic HTTP webhook/)).toBeVisible();
  await section.getByText('Recent routing decisions (1)', { exact: true }).click();
  await expect(
    section.getByText('No deployment required. No changed paths match the routing policy.', { exact: true }),
  ).toBeVisible();
  expect(triggers).toBe(1);
  await section.getByLabel('Binding enabled').uncheck();
  await section.getByRole('button', { name: 'Save binding' }).click();
  await expect(section.getByRole('button', { name: 'Deploy now', exact: true })).toBeDisabled();
  await section
    .getByRole('button', { name: 'Validate destination' })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(section.getByText('Destination validation: Passed', { exact: true })).toBeVisible();
  expect(validations).toBe(2);
  await expect(
    section.getByText(/Automatic deployment is paused because a previous request has an unknown outcome/),
  ).toBeVisible();
  expect(triggers).toBe(1);
  await expectAccessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await section.screenshot({
    path: `test-results/deployment-${info.project.name}.png`,
    style: '.mobile-bar { visibility: hidden; }',
  });
  await section.getByRole('button', { name: 'Remove binding…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove binding', exact: true }).click();
  await expect(section.getByText('Not configured', { exact: true })).toBeVisible();
  await section.getByLabel('Binding enabled').check();
  await section.getByLabel('Webhook URL', { exact: true }).fill('https://generic.example/recreated');
  await section.getByRole('button', { name: 'Save binding' }).click();
  await expect(section.getByText('Configured (••••)', { exact: true })).toBeVisible();
  await section.getByLabel('Replacement webhook URL').fill('https://unsaved.example/keep');
  changeDuringValidation = true;
  await section.getByRole('button', { name: 'Validate destination' }).click();
  await expect(section.getByRole('alert')).toHaveText(
    'Deployment settings changed. Reload before saving or deploying.',
  );
  await expect(section.getByLabel('Replacement webhook URL')).toHaveValue('https://unsaved.example/keep');
  await expect(section.getByLabel('Binding enabled')).toBeChecked();
  await section.getByRole('button', { name: 'Save binding' }).click();
  await expect(section.getByRole('alert')).toHaveText('Settings changed in another tab.');
  await expect(section.getByLabel('Replacement webhook URL')).toHaveValue('https://unsaved.example/keep');
});
