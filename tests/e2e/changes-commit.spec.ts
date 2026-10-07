import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { AUTH_STATE, expectAccessible, SAMPLE_REMOTE, SAMPLE_STATE } from './support';

test.use({ storageState: AUTH_STATE });
test.skip(!SAMPLE_REMOTE, 'Set E2E_GIT_REMOTE to run the Changes commit tests.');

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 900;
const sample = () =>
  JSON.parse(fs.readFileSync(SAMPLE_STATE, 'utf8')) as {
    workspaceId: string;
    repositoryId: string;
    stackId: string;
  };
const stackUrl = () => `/w/${sample().workspaceId}/stacks/${sample().stackId}`;
const identityHref = () => `/w/${sample().workspaceId}/settings/account#ws-account-git-identity`;

async function openChanges(page: Page) {
  await page
    .getByRole('navigation', { name: 'Stack' })
    .getByRole('link', { name: /Changes/ })
    .click();
  await expect(page).toHaveURL(/\/changes$/);
}

async function saveDraftMarker(page: Page, marker: string) {
  await page.goto(stackUrl());
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(`\n# ${marker}\n`);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.editor-toolbar').getByText('Draft', { exact: true })).toBeVisible();
}

async function setGitIdentity(page: Page, name = 'E2E Operator', email = 'e2e@example.invalid') {
  if (!/^https?:\/\//.test(page.url())) await page.goto('/');
  const res = await page.request.put('/api/auth/git-identity', {
    headers: { Origin: new URL(page.url()).origin },
    data: { name, email },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** Clears stack drafts via the API so cleanup is not blocked by overlapping UI chrome. */
async function discardAllDrafts(page: Page) {
  const { workspaceId, stackId } = sample();
  if (!/^https?:\/\//.test(page.url())) await page.goto(stackUrl());
  const origin = new URL(page.url()).origin;
  const listed = await page.request.get(`/api/workspaces/${workspaceId}/stacks/${stackId}/drafts`);
  expect(listed.status(), await listed.text()).toBe(200);
  const { changes } = (await listed.json()) as { changes: Array<{ path: string }> };
  for (const change of changes) {
    const res = await page.request.delete(
      `/api/workspaces/${workspaceId}/stacks/${stackId}/drafts?path=${encodeURIComponent(change.path)}`,
      { headers: { Origin: origin } },
    );
    expect(res.ok(), await res.text()).toBeTruthy();
  }
}

test('changes shows diffs, commit form, missing identity and is accessible', async ({ page }) => {
  test.skip(isMobile(page), 'Desktop covers the full commit form; mobile has a dedicated layout test.');
  const marker = `commit-ui-${Date.now()}`;
  const { repositoryId } = sample();
  // Shared e2e DB may already have an identity from parallel projects; drive the outcome via the API contract.
  await setGitIdentity(page);
  await saveDraftMarker(page, marker);
  await page.goto(changesUrl());

  await expect(page.getByRole('status').filter({ hasText: /draft/ })).toContainText(/draft/);
  await expect(page.locator('.diff')).toContainText(marker);
  await expect(page.getByRole('region', { name: 'Commit changes' })).toBeVisible();
  await expect(page.getByLabel('Commit message')).toBeVisible();

  await page.route(`**/repositories/${repositoryId}/git/commit`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'git_identity_missing',
        repositoryId,
        branch: 'main',
        operation: 'commit',
        commitSha: null,
        expectedRemoteSha: null,
        state: null,
        problems: [],
        outdatedPaths: [],
        draftsPreserved: true,
      }),
    });
  });
  await page.getByLabel('Commit message').fill(`e2e: ${marker}`);
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.getByText('Git identity required to commit')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Git identity settings' })).toHaveAttribute(
    'href',
    identityHref(),
  );
  await expect(page.getByText('git_identity_missing')).toHaveCount(0);

  await expectAccessible(page);
  await page.unroute(`**/repositories/${repositoryId}/git/commit`);
  await discardAllDrafts(page);
});

test('validation errors block commit and link back to the file', async ({ page }) => {
  test.skip(isMobile(page), 'Validation coverage runs once on desktop.');
  await setGitIdentity(page);
  await page.goto(stackUrl());
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('services:\n  app:\n    image: [broken\n');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.editor-toolbar').getByText('Draft', { exact: true })).toBeVisible();

  await openChanges(page);
  await expect(page.getByText(/blocking error/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
  await expect(page.getByText('Validation blocked')).toBeVisible();
  await expectAccessible(page);

  await discardAllDrafts(page);
});

test('successful commit refreshes and keeps drafts visible', async ({ page }) => {
  test.skip(isMobile(page), 'Commit success runs once on desktop.');
  await setGitIdentity(page);
  const marker = `committed-${Date.now()}`;
  await saveDraftMarker(page, marker);
  // Identity is read on the server; reload Changes after setting it.
  await page.goto(changesUrl());
  await expect(page.locator('.diff')).toContainText(marker);

  await page.getByLabel('Commit message').fill(`e2e: ${marker}`);
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Commit', exact: true }).click();

  await expect(page.getByRole('status').filter({ hasText: /Committed as/ })).toBeVisible();
  await expect(page.locator('.diff')).toContainText(marker);
  await expect(page.getByRole('status').filter({ hasText: /draft/ })).toContainText(/draft/);
  await expectAccessible(page);

  await discardAllDrafts(page);
});

test('remote-changed push keeps work and offers fetch', async ({ page }) => {
  test.skip(isMobile(page), 'Push-failure UX runs once on desktop.');
  await setGitIdentity(page);
  const marker = `push-fail-${Date.now()}`;
  const { repositoryId } = sample();
  await saveDraftMarker(page, marker);
  await page.goto(changesUrl());

  await page.route(`**/repositories/${repositoryId}/git/commit`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const sha = 'a'.repeat(40);
    const remote = 'b'.repeat(40);
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'remote_changed',
        repositoryId,
        branch: 'master',
        operation: 'push',
        commitSha: sha,
        expectedRemoteSha: remote,
        state: {
          branch: 'master',
          localHeadSha: sha,
          remoteHeadSha: 'c'.repeat(40),
          ahead: 1,
          behind: 1,
        },
        problems: [],
        outdatedPaths: [],
        draftsPreserved: true,
        reason: 'conflict',
      }),
    });
  });

  await page.getByLabel('Commit message').fill(`e2e: ${marker}`);
  await page.getByRole('button', { name: 'Commit & Push' }).click();

  await expect(page.getByText('The remote branch changed since your copy was last updated.')).toBeVisible();
  await expect(page.getByText(/drafts are still safe/i)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open repository to fetch' })).toBeVisible();
  await expect(page.locator('.diff')).toContainText(marker);
  await expectAccessible(page);

  await page.unroute(`**/repositories/${repositoryId}/git/commit`);
  await discardAllDrafts(page);
});

test('mocked push success shows branch confirmation', async ({ page }) => {
  test.skip(isMobile(page), 'Push success message runs once on desktop.');
  await setGitIdentity(page);
  const marker = `push-ok-${Date.now()}`;
  const { repositoryId } = sample();
  await saveDraftMarker(page, marker);
  await page.goto(changesUrl());

  const sha = 'd'.repeat(40);
  await page.route(`**/repositories/${repositoryId}/git/commit`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'push_succeeded',
        repositoryId,
        branch: 'main',
        operation: 'push',
        commitSha: sha,
        expectedRemoteSha: 'e'.repeat(40),
        state: {
          branch: 'main',
          localHeadSha: sha,
          remoteHeadSha: sha,
          ahead: 0,
          behind: 0,
        },
        problems: [],
        outdatedPaths: [],
        draftsPreserved: true,
      }),
    });
  });

  await page.getByLabel('Commit message').fill(`e2e: ${marker}`);
  await page.getByRole('button', { name: 'Commit & Push' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Pushed ddddddd to main/ })).toBeVisible();
  await expect(page.locator('.diff')).toContainText(marker);
  await expectAccessible(page);

  await page.unroute(`**/repositories/${repositoryId}/git/commit`);
  await discardAllDrafts(page);
});

test('mobile: changes commit layout and accessibility', async ({ page }) => {
  test.skip(!isMobile(page), 'Narrow layout only.');
  await setGitIdentity(page);
  const marker = `mobile-${Date.now()}`;
  await saveDraftMarker(page, marker);
  await page.goto(changesUrl());

  await expect(page.getByRole('region', { name: 'Commit changes' })).toBeVisible();
  await expect(page.getByLabel('Commit message')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit & Push' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discard…' }).first()).toBeVisible();
  await expect(page.locator('.diff')).toContainText(marker);
  await expectAccessible(page);

  await discardAllDrafts(page);
  await page.goto(changesUrl());
  await expect(page.getByRole('heading', { name: 'No draft changes' })).toBeVisible();
});

function changesUrl() {
  return `${stackUrl()}/changes`;
}
