import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { AUTH_STATE, expectAccessible, SAMPLE_REMOTE, SAMPLE_STATE } from './support';

test.use({ storageState: AUTH_STATE });
test.skip(!SAMPLE_REMOTE, 'Set E2E_GIT_REMOTE to run the Changes commit tests.');
// Playwright runs this file in dedicated projects after source/shell (see playwright.config.ts).
test.describe.configure({ mode: 'serial' });

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 900;
const sample = () =>
  JSON.parse(fs.readFileSync(SAMPLE_STATE, 'utf8')) as {
    workspaceId: string;
    repositoryId: string;
    stackId: string;
  };
const stackUrl = () => `/w/${sample().workspaceId}/stacks/${sample().stackId}`;
const changesUrl = () => `${stackUrl()}/changes`;
const identityHref = () => `/w/${sample().workspaceId}/settings/account#ws-account-git-identity`;

/** Saves a unique marker via the drafts API (avoids CodeMirror/mobile input flakiness). */
async function saveDraftMarker(page: Page, marker: string) {
  const { workspaceId, stackId } = sample();
  if (!/^https?:\/\//.test(page.url())) await page.goto(stackUrl());
  const origin = new URL(page.url()).origin;
  const headers = { Origin: origin };
  const stackRes = await page.request.get(`/api/workspaces/${workspaceId}/stacks/${stackId}`);
  expect(stackRes.status(), await stackRes.text()).toBe(200);
  const { stack } = (await stackRes.json()) as { stack: { composePath: string } };
  const path = stack.composePath;
  const fileRes = await page.request.get(
    `/api/workspaces/${workspaceId}/stacks/${stackId}/files?path=${encodeURIComponent(path)}`,
  );
  expect(fileRes.status(), await fileRes.text()).toBe(200);
  const { file } = (await fileRes.json()) as {
    file: { content: string | null; blobSha: string | null; draft: { content: string } | null };
  };
  // Always restart from the committed blob so a prior validation test cannot leave broken YAML.
  const base = file.content ?? '';
  const content = `${base.replace(/\n$/, '')}\n# ${marker}\n`;
  const put = await page.request.put(`/api/workspaces/${workspaceId}/stacks/${stackId}/drafts`, {
    headers,
    data: { path, content, baseBlobSha: file.blobSha },
  });
  expect(put.status(), await put.text()).toBe(200);
}

async function setGitIdentity(page: Page, name = 'E2E Operator', email = 'e2e@example.invalid') {
  if (!/^https?:\/\//.test(page.url())) await page.goto('/');
  const res = await page.request.put('/api/auth/git-identity', {
    headers: { Origin: new URL(page.url()).origin },
    data: { name, email },
  });
  expect(res.status(), await res.text()).toBe(200);
}

async function draftCount(page: Page) {
  const { workspaceId, stackId } = sample();
  const listed = await page.request.get(`/api/workspaces/${workspaceId}/stacks/${stackId}/drafts`);
  expect(listed.status(), await listed.text()).toBe(200);
  return ((await listed.json()) as { changes: unknown[] }).changes.length;
}

/** Drafts must still exist after a failed/retained Git operation (cross-worker safe). */
async function expectWorkPreserved(page: Page) {
  expect(await draftCount(page)).toBeGreaterThan(0);
  await expect(page.locator('.diff').first()).toBeVisible();
}

async function openChangesWithDraft(page: Page, marker: string) {
  await saveDraftMarker(page, marker);
  await page.goto(changesUrl());
  if (await page.getByRole('heading', { name: 'No draft changes' }).isVisible()) {
    await saveDraftMarker(page, marker);
    await page.goto(changesUrl());
  }
  await expect(page.locator('.diff').first()).toBeVisible();
}

test('changes shows diffs, commit form, missing identity and is accessible', async ({ page }) => {
  test.skip(isMobile(page), 'Desktop covers the full commit form; mobile has a dedicated layout test.');
  const marker = `commit-ui-${Date.now()}`;
  const { repositoryId } = sample();
  await setGitIdentity(page);
  await openChangesWithDraft(page, marker);

  await expect(page.getByRole('status').filter({ hasText: /draft/ })).toContainText(/draft/);
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
  await expectWorkPreserved(page);
  await expect(page).toHaveTitle(/Changes/);
  await expectAccessible(page);
  await page.unroute(`**/repositories/${repositoryId}/git/commit`);
});

test('validation errors block commit and link back to the file', async ({ page }) => {
  test.skip(isMobile(page), 'Validation coverage runs once on desktop.');
  await setGitIdentity(page);
  const { workspaceId, stackId } = sample();
  if (!/^https?:\/\//.test(page.url())) await page.goto(stackUrl());
  const origin = new URL(page.url()).origin;
  const stackRes = await page.request.get(`/api/workspaces/${workspaceId}/stacks/${stackId}`);
  const { stack } = (await stackRes.json()) as { stack: { composePath: string } };
  const fileRes = await page.request.get(
    `/api/workspaces/${workspaceId}/stacks/${stackId}/files?path=${encodeURIComponent(stack.composePath)}`,
  );
  const { file } = (await fileRes.json()) as {
    file: { blobSha: string | null };
  };
  const put = await page.request.put(`/api/workspaces/${workspaceId}/stacks/${stackId}/drafts`, {
    headers: { Origin: origin },
    data: {
      path: stack.composePath,
      content: 'services:\n  app:\n    image: [broken\n',
      baseBlobSha: file.blobSha,
    },
  });
  expect(put.status(), await put.text()).toBe(200);

  await page.goto(changesUrl());
  await expect(page.getByText(/blocking error/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
  await expect(page.getByText('Validation blocked')).toBeVisible();
  await expect(page).toHaveTitle(/Changes/);
  await expectAccessible(page);
});

test('successful commit refreshes and keeps drafts visible', async ({ page }) => {
  test.skip(isMobile(page), 'Commit success runs once on desktop.');
  await setGitIdentity(page);
  const marker = `committed-${Date.now()}`;
  await openChangesWithDraft(page, marker);

  await page.getByLabel('Commit message').fill(`e2e: ${marker}`);
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Commit', exact: true }).click();

  await expect(page.getByRole('status').filter({ hasText: /Committed as/ })).toBeVisible();
  await expectWorkPreserved(page);
  await expect(page).toHaveTitle(/Changes/);
  await expectAccessible(page);
});

test('remote-changed push keeps work and offers fetch', async ({ page }) => {
  test.skip(isMobile(page), 'Push-failure UX runs once on desktop.');
  await setGitIdentity(page);
  const marker = `push-fail-${Date.now()}`;
  const { repositoryId } = sample();
  await openChangesWithDraft(page, marker);

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
  await expect(page.getByText(/never force pushes/i)).toBeVisible();
  await expect(page.getByText(/aaaaaaa was not pushed/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open repository to fetch' })).toBeVisible();
  await expectWorkPreserved(page);
  await expect(page).toHaveTitle(/Changes/);
  await expectAccessible(page);
  await page.unroute(`**/repositories/${repositoryId}/git/commit`);
});

test('mocked push success shows branch confirmation', async ({ page }) => {
  test.skip(isMobile(page), 'Push success message runs once on desktop.');
  await setGitIdentity(page);
  const marker = `push-ok-${Date.now()}`;
  const { repositoryId } = sample();
  await openChangesWithDraft(page, marker);

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
  await expectWorkPreserved(page);
  await expect(page).toHaveTitle(/Changes/);
  await expectAccessible(page);
  await page.unroute(`**/repositories/${repositoryId}/git/commit`);
});

test('mobile: changes commit layout and accessibility', async ({ page }) => {
  test.skip(!isMobile(page), 'Narrow layout only.');
  await setGitIdentity(page);
  const marker = `mobile-${Date.now()}`;
  await openChangesWithDraft(page, marker);

  await expect(page.getByRole('region', { name: 'Commit changes' })).toBeVisible();
  await expect(page.getByLabel('Commit message')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit & Push' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discard…' }).first()).toBeVisible();
  await expectWorkPreserved(page);
  await expect(page).toHaveTitle(/Changes/);
  await expectAccessible(page);
});
