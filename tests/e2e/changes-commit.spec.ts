import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { AUTH_STATE, expectAccessible, SAMPLE_REMOTE, SAMPLE_ROOT, SAMPLE_STATE } from './support';

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

test('plans and stages a manual image update without WUD', async ({ page }) => {
  // The desktop run stages a draft on the shared stack. Running on mobile would mutate it twice.
  // The scenario selects the proxy service from the nginx-golang fixture.
  test.skip(
    isMobile(page) || SAMPLE_ROOT !== 'nginx-golang',
    'Stages once on desktop using the nginx-golang fixture’s proxy service.',
  );
  const { workspaceId, stackId } = sample();
  const path = 'nginx-golang/compose.yaml';
  await page.goto(`${stackUrl()}/image-updates`);
  await page.getByRole('link', { name: 'Image update setup guide' }).click();
  await expect(page.getByRole('heading', { name: 'Set up image updates' })).toBeVisible();
  await expect(page.getByLabel('WUD URL')).toBeVisible();
  await page.getByRole('link', { name: 'Open image updates', exact: true }).click();
  const add = page.getByRole('form', { name: 'Add a manual image update' });
  await expect(page.getByRole('columnheader', { name: 'Image saved in Git' })).toBeVisible();
  await expect(add.getByLabel('Stack to edit')).toHaveCount(0);
  await add.getByLabel('Compose service to update').selectOption('proxy');
  await add.getByLabel('New image tag').fill('1.29.2');
  await add.getByRole('button', { name: 'Add tag to review' }).click();
  await page.getByRole('button', { name: 'Review proposed updates' }).click();
  const review = page.getByRole('form', { name: 'Save image update drafts' });
  await expect(review.getByText('No changelog link was supplied.')).toBeVisible();
  await expect(review.getByRole('button', { name: 'Save selected drafts' })).toBeDisabled();
  await expectAccessible(page);
  await review.getByRole('checkbox', { name: `Include ${path} and acknowledge review` }).check();
  await review.getByRole('button', { name: 'Save selected drafts' }).click();
  try {
    await page.getByRole('link', { name: 'Open Changes for Sample' }).click();
    await expect(page.locator('.diff').first()).toContainText('nginx:1.29.2');
  } finally {
    const cleanup = await page.request.delete(
      `/api/workspaces/${workspaceId}/stacks/${stackId}/drafts?path=${encodeURIComponent(path)}`,
      {
        headers: { Origin: new URL(page.url()).origin },
      },
    );
    expect(cleanup.ok()).toBe(true);
  }
});

test('shows the repository workflow instead of draft controls for preview-only updates', async ({ page }) => {
  // The nginx-golang fixture supplies the proxy image needed to add a tag to the review.
  test.skip(SAMPLE_ROOT !== 'nginx-golang', 'Uses the proxy image in the nginx-golang fixture.');
  const { workspaceId, stackId } = sample();
  await page.route(`**/api/workspaces/${workspaceId}/image-updates/preview`, (route) =>
    route.fulfill({
      json: {
        files: [
          {
            stackId,
            stackName: 'Sample',
            path: 'nginx-golang/compose.yaml',
            repositoryWorkflow: true,
            status: 'blocked',
            reason: 'Use your repository’s WUD update workflow to make this change.',
            token: null,
            changes: [
              {
                service: 'proxy',
                source: 'manual',
                status: 'review',
                before: 'nginx',
                after: 'nginx:1.29.2',
                notes: ['Missing release range.'],
                changelogUrl: null,
              },
            ],
          },
        ],
      },
    }),
  );

  await page.goto(`${stackUrl()}/image-updates`);
  const add = page.getByRole('form', { name: 'Add a manual image update' });
  await add.getByLabel('Compose service to update').selectOption('proxy');
  const tag = add.getByLabel('New image tag');
  await tag.fill('1.29.2');
  await tag.press('Enter');
  await expect(add).toHaveCount(0);
  await page.getByRole('button', { name: 'Review proposed updates' }).press('Enter');
  const preview = page.getByRole('form', { name: 'Image update preview' });
  await expect(preview.getByText('Preview only', { exact: true })).toBeVisible();
  await expect(preview.getByText(/Use your repository’s WUD update workflow/)).toBeVisible();
  await expect(preview.getByText('Check before updating')).toBeVisible();
  await expect(preview.getByRole('link', { name: 'Open setup guide' })).toHaveAttribute(
    'href',
    `${stackUrl()}/image-updates/setup`,
  );
  await expect(page.getByRole('button', { name: 'Save selected drafts' })).toHaveCount(0);
});

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
  await expect(
    page.getByText(/can't merge or rebase yet, so this work needs to be brought across by hand/i),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open repository to fetch' })).toBeVisible();
  await expectWorkPreserved(page);
  await expect(page).toHaveTitle(/Changes/);
  await expectAccessible(page);
  await page.unroute(`**/repositories/${repositoryId}/git/commit`);
});

test('push confirmation remains visible when fetch clears the last draft', async ({ page }) => {
  test.skip(isMobile(page), 'Push success message runs once on desktop.');
  await setGitIdentity(page);
  const marker = `push-ok-${Date.now()}`;
  const { repositoryId, workspaceId, stackId } = sample();
  await openChangesWithDraft(page, marker);

  const sha = 'd'.repeat(40);
  await page.route(`**/repositories/${repositoryId}/git/commit`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const { paths } = route.request().postDataJSON() as { paths: string[] };
    // The browser fixture is read-only on GitHub. Simulate the post-push fetch clearing its draft.
    const cleared = await page.request.delete(
      `/api/workspaces/${workspaceId}/stacks/${stackId}/drafts?path=${encodeURIComponent(paths[0]!)}`,
      { headers: { Origin: new URL(page.url()).origin } },
    );
    expect(cleared.ok()).toBe(true);
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
  await expect(page.getByRole('heading', { name: 'No draft changes' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /Pushed ddddddd to main/ })).toBeVisible();
  await expect(page).toHaveTitle(/Changes/);
  await expectAccessible(page);
  await page.unroute(`**/repositories/${repositoryId}/git/commit`);
});

test('an unpushed commit from an earlier visit can still be pushed', async ({ page }) => {
  test.skip(isMobile(page), 'Retained push recovery runs once on desktop.');
  await setGitIdentity(page);
  const marker = `retained-${Date.now()}`;
  const { repositoryId } = sample();
  await openChangesWithDraft(page, marker);

  const local = 'f'.repeat(40);
  const remote = '1'.repeat(40);
  await page.route(`**/repositories/${repositoryId}/git/commit`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'draft_outdated',
        repositoryId,
        branch: 'main',
        operation: 'inspect',
        commitSha: null,
        expectedRemoteSha: remote,
        state: { branch: 'main', localHeadSha: local, remoteHeadSha: remote, ahead: 1, behind: 0 },
        problems: [],
        outdatedPaths: [],
        draftsPreserved: true,
      }),
    });
  });
  let pushed: unknown = null;
  await page.route(`**/repositories/${repositoryId}/git/push`, async (route) => {
    pushed = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'push_succeeded',
        repositoryId,
        branch: 'main',
        operation: 'push',
        commitSha: local,
        expectedRemoteSha: remote,
        state: { branch: 'main', localHeadSha: local, remoteHeadSha: local, ahead: 0, behind: 0 },
        problems: [],
        outdatedPaths: [],
        draftsPreserved: true,
      }),
    });
  });

  await page.getByLabel('Commit message').fill(`e2e: ${marker}`);
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await page.getByRole('button', { name: 'Push fffffff' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Pushed fffffff to main/ })).toBeVisible();
  expect(pushed).toEqual({ commitSha: local, expectedRemoteSha: remote });
  await expectWorkPreserved(page);
  await page.unroute(`**/repositories/${repositoryId}/git/commit`);
  await page.unroute(`**/repositories/${repositoryId}/git/push`);
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
