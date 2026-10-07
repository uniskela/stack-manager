import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { AUTH_STATE, expectAccessible, SAMPLE_REMOTE, SAMPLE_ROOT, SAMPLE_STATE } from './support';

test.use({ storageState: AUTH_STATE });
test.skip(!SAMPLE_REMOTE, 'Set E2E_GIT_REMOTE to run the source workspace tests.');

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 900;
const sample = () =>
  JSON.parse(fs.readFileSync(SAMPLE_STATE, 'utf8')) as {
    workspaceId: string;
    repositoryId: string;
    stackId: string;
  };
const stackUrl = () => `/w/${sample().workspaceId}/stacks/${sample().stackId}`;

test('stack pages render and are accessible', async ({ page }) => {
  await page.goto(`/w/${sample().workspaceId}/stacks`);
  await expect(page.getByRole('heading', { level: 1, name: 'Stacks' })).toBeVisible();
  await expectAccessible(page);

  await page.goto(stackUrl());
  await expect(page.locator('.cm-editor')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Stack' })).toBeVisible();
  await expectAccessible(page);

  for (const tab of ['Docs', 'Environment', 'Changes', 'History', 'Settings']) {
    await page
      .getByRole('navigation', { name: 'Stack' })
      .getByRole('link', { name: new RegExp(tab) })
      .click();
    await expect(
      page.getByRole('navigation', { name: 'Stack' }).getByRole('link', { name: new RegExp(tab) }),
    ).toHaveAttribute('aria-current', 'page');
    await expectAccessible(page);
  }
});

test('stacks search reaches collapsed repositories, counts results and clears', async ({ page }) => {
  await page.goto(`/w/${sample().workspaceId}/stacks`);
  const repoHeader = page.getByRole('heading', { level: 2 }).first().getByRole('button');
  // The sample stack's folder group is labelled with its parent folder.
  const parent = SAMPLE_ROOT.includes('/') ? SAMPLE_ROOT.slice(0, SAMPLE_ROOT.lastIndexOf('/')) : '';
  const folderLabel = parent || 'Repository root';
  const folderHeader = page
    .getByRole('heading', { level: 3 })
    .filter({ hasText: folderLabel })
    .first()
    .getByRole('button');
  const sampleRow = page.getByRole('link', { name: /^Sample\b/ });
  const count = page.getByRole('status').filter({ hasText: /stacks?$/ });
  await expect(count).toHaveText(/^\d+ stacks?$/);
  await expect(repoHeader).toHaveAttribute('aria-expanded', 'true');
  await expectAccessible(page);

  // Folder groups collapse on their own.
  await folderHeader.click();
  await expect(folderHeader).toHaveAttribute('aria-expanded', 'false');
  await expect(sampleRow).toBeHidden();
  await folderHeader.click();
  await expect(sampleRow).toBeVisible();

  // Collapse the repository: its stacks leave the list.
  await repoHeader.click();
  await expect(repoHeader).toHaveAttribute('aria-expanded', 'false');
  await expect(sampleRow).toBeHidden();

  // "/" focuses search, and a match inside the collapsed repository is shown.
  const search = page.getByLabel('Search stacks');
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await search.fill('sample');
  await expect(sampleRow).toBeVisible();
  await expect(repoHeader).toHaveAttribute('aria-expanded', 'true');
  await expect(count).toHaveText(/^(\d+ of )?\d+ stacks?$/);

  // Escape clears the search and restores the saved (collapsed) layout.
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(repoHeader).toHaveAttribute('aria-expanded', 'false');
  await repoHeader.click();

  await search.fill('zz-no-such-stack');
  await expect(page.getByRole('heading', { name: 'No stacks match' })).toBeVisible();
  await expect(count).toHaveText(/^0 of \d+ stacks?$/);
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Clear search' }).first().click();
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(sampleRow).toBeVisible();
});

test('stacks view lives in the URL and survives opening a stack and going Back', async ({ page }) => {
  await page.goto(`/w/${sample().workspaceId}/stacks?sort=path`);
  const group = page.getByLabel('Group');
  const sort = page.getByLabel('Sort');
  // On phones sort and grouping sit behind the Filters disclosure.
  if (isMobile(page)) {
    await expect(group).toBeHidden();
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
  }
  await expect(sort).toHaveValue('path');
  await expectAccessible(page);

  // Collapse all / expand all act on every repository.
  const repoHeader = page.getByRole('heading', { level: 2 }).first().getByRole('button');
  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect(repoHeader).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Expand all' }).click();
  await expect(repoHeader).toHaveAttribute('aria-expanded', 'true');

  // Flat list, search highlighted, all written to the URL.
  await group.selectOption('none');
  await expect(page.getByRole('button', { name: 'Expand all' })).toBeHidden();
  await page.getByLabel('Search stacks').fill('sample');
  const sampleRow = page.getByRole('list', { name: 'Stacks' }).getByRole('link', { name: /^Sample\b/ });
  await expect(sampleRow.locator('mark')).toHaveText('Sample');
  await expect(page).toHaveURL(/[?&]q=sample\b/);
  await expect(page).toHaveURL(/[?&]group=none\b/);
  await expect(page).toHaveURL(/[?&]sort=path\b/);

  await sampleRow.click();
  await expect(page.getByRole('navigation', { name: 'Stack' })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Search stacks')).toHaveValue('sample');
  if (isMobile(page)) await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await expect(group).toHaveValue('none');
  await expect(sampleRow).toBeVisible();
});

test('stack breadcrumbs return to the list as it was left; arrow keys move through the list', async ({
  page,
}) => {
  await page.goto(`/w/${sample().workspaceId}/stacks?group=repository`);
  const search = page.getByLabel('Search stacks');
  await search.fill('sample');

  // ↓ from search enters the list, ↑ from its first item goes back.
  await search.press('ArrowDown');
  const repoHeader = page.getByRole('heading', { level: 2 }).first().getByRole('button');
  await expect(repoHeader).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const sampleRow = page.getByRole('link', { name: /^Sample\b/ });
  await expect(sampleRow).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(search).toBeFocused();

  await sampleRow.click();
  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumbs.getByRole('link', { name: 'Stacks' })).toHaveAttribute(
    'href',
    /\/stacks\?q=sample&group=repository$/,
  );
  await expect(crumbs.getByRole('link').nth(1)).toHaveAttribute(
    'href',
    `/w/${sample().workspaceId}/stacks?repo=${sample().repositoryId}`,
  );
  await expect(crumbs.getByText('Sample')).toHaveAttribute('aria-current', 'page');
  // The switcher appears only when the repository has another stack to switch to.
  const listed = await page.request.get(
    `/api/workspaces/${sample().workspaceId}/repositories/${sample().repositoryId}/stacks`,
  );
  const siblings = ((await listed.json()) as { stacks: unknown[] }).stacks.length;
  await expect(page.getByRole('button', { name: 'Switch stack' })).toHaveCount(siblings > 1 ? 1 : 0);

  await crumbs.getByRole('link', { name: 'Stacks' }).click();
  await expect(page.getByLabel('Search stacks')).toHaveValue('sample');
  await expect(page).toHaveURL(/group=repository/);
});

test('edit, save a draft, review and discard it', async ({ page }) => {
  test.skip(
    isMobile(page),
    'The editing flow runs once, on desktop; mobile covers layout and accessibility.',
  );
  await page.goto(stackUrl());
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n# edited by e2e\n');
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeEnabled();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.editor-toolbar').getByText('Draft', { exact: true })).toBeVisible();

  await expect(page.getByRole('link', { name: /drafts?, open Changes/ })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Stack' }).getByRole('link', { name: /Changes/ }),
  ).toContainText(/1/);

  // Leave the editor so the g c chord is not swallowed by CodeMirror.
  await page
    .getByRole('navigation', { name: 'Stack' })
    .getByRole('link', { name: /History/ })
    .focus();
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await expect(page).toHaveURL(/\/changes$/);
  await expect(page.locator('.diff')).toContainText('# edited by e2e');
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Discard…' }).click();
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await expect(page.getByRole('heading', { name: 'No draft changes' })).toBeVisible();
  await expect(page.getByRole('link', { name: /drafts?, open Changes/ })).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Stack' }).getByRole('link', { name: /^Changes$/ }),
  ).toBeVisible();
});

test('stack history lists commits, opens detail, and handles empty/load-more', async ({ page }) => {
  const { workspaceId, stackId } = sample();
  const historyPath = `/api/workspaces/${workspaceId}/stacks/${stackId}/history`;
  const filePath = SAMPLE_ROOT ? `${SAMPLE_ROOT}/compose.yaml` : 'compose.yaml';
  const headSha = 'a'.repeat(40);
  const commit = (sha: string, subject: string, authoredAt: string) => ({
    sha,
    shortSha: sha.slice(0, 7),
    parents: [] as string[],
    subject,
    message: `${subject}\n`,
    author: { name: 'Operator', email: 'op@example.invalid' },
    authoredAt,
    committedAt: authoredAt,
    files: [{ path: filePath, status: 'modified' as const }],
    filesTruncated: false,
  });

  const historyRoute = (url: URL) => url.pathname === historyPath || url.pathname.startsWith(`${historyPath}/`);

  await page.route(historyRoute, async (route) => {
    const url = new URL(route.request().url());
    const sha = url.pathname.slice(historyPath.length + 1);
    if (sha.length === 40) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repositoryId: 'repo',
          rootPath: SAMPLE_ROOT,
          headSha,
          commit: {
            ...commit(sha, 'First page commit', '2026-10-02T12:00:00+00:00'),
            diffBaseSha: null,
            files: [
              {
                path: filePath,
                status: 'modified',
                locked: null,
                hunks: [
                  {
                    oldStart: 1,
                    oldLines: 1,
                    newStart: 1,
                    newLines: 1,
                    lines: ['-image: old', '+image: new'],
                  },
                ],
              },
            ],
          },
        }),
      });
      return;
    }
    if (url.searchParams.get('cursor')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repositoryId: 'repo',
          rootPath: SAMPLE_ROOT,
          headSha,
          commits: [commit('b'.repeat(40), 'Second page commit', '2026-10-01T12:00:00+00:00')],
          nextCursor: null,
          historyLimitReached: false,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        repositoryId: 'repo',
        rootPath: SAMPLE_ROOT,
        headSha,
        commits: [commit(headSha, 'First page commit', '2026-10-02T12:00:00+00:00')],
        nextCursor: 'cursor-page-2',
        historyLimitReached: false,
      }),
    });
  });

  await page.goto(`${stackUrl()}/history`);
  const list = page.getByRole('list', { name: 'Stack history' });
  await expect(list.getByRole('button', { name: /First page commit/ })).toBeVisible();
  await expectAccessible(page);

  await list.getByRole('button', { name: /First page commit/ }).click();
  await expect(page.getByRole('region', { name: 'Commit details' })).toBeVisible();
  await expect(page.locator('.diff')).toContainText('image: new');
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(list.getByRole('button', { name: /Second page commit/ })).toBeVisible();

  await page.unroute(historyRoute);
  await page.route(historyRoute, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        repositoryId: 'repo',
        rootPath: SAMPLE_ROOT,
        headSha,
        commits: [],
        nextCursor: null,
        historyLimitReached: false,
      }),
    });
  });
  await page.goto(`${stackUrl()}/history`);
  await expect(page.getByRole('heading', { name: 'No commits for this stack' })).toBeVisible();
  await expect(page.getByText('No commits touching this stack were found.')).toBeVisible();
  await expectAccessible(page);
});

test('mobile: the explorer opens as an overlay', async ({ page }) => {
  test.skip(!isMobile(page), 'Narrow layout only.');
  await page.goto(stackUrl());
  await page.getByRole('button', { name: 'Files' }).click();
  await expect(page.getByRole('complementary', { name: 'Explorer' })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Close explorer' }).click();
  await expect(page.getByRole('complementary', { name: 'Explorer' })).toBeHidden();
});

test('repository page pages through Compose folders and adds them all', async ({ page }) => {
  await page.goto(`/w/${sample().workspaceId}/repositories/${sample().repositoryId}`);
  const folders = page.getByRole('list', { name: 'Compose folders' });
  await expect(folders).toBeVisible();
  await expect(page.getByLabel('Add new stacks automatically')).not.toBeChecked();
  await expectAccessible(page);

  const pager = page.getByRole('navigation', { name: 'Compose folder pages' });
  if (await pager.isVisible()) {
    await expect(pager).toContainText(/^.*1–25 of \d+/);
    await pager.getByRole('button', { name: 'Next' }).click();
    await expect(pager).toContainText(/26–/);
  }

  // The desktop and mobile projects share one instance: only the first run still has folders to add.
  const addAll = page.getByRole('button', { name: /^Add all \d+ stacks$|^Add the new stack$/ });
  if (await addAll.isVisible()) {
    await addAll.click();
    await expect(page.getByRole('status')).toContainText(/Added \d+ stacks?\./);
  }
  await expect(addAll).toBeHidden();
  await expect(folders.getByRole('checkbox')).toHaveCount(0);
});

test('repository Files, Docs and Changes tabs cover files outside stacks', async ({ page }) => {
  // Three tabs × light/dark axe is close to the default 30s budget under parallel load.
  test.setTimeout(60_000);
  const base = `/w/${sample().workspaceId}/repositories/${sample().repositoryId}`;
  const tabs = page.getByRole('navigation', { name: 'Repository' });

  await page.goto(`${base}/files`);
  await expect(tabs.getByRole('link', { name: /Files/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.cm-editor')).toBeVisible();
  // The landing file is the root README.
  await expect(page.locator('.cm-content')).toContainText(/\S/);
  await expect(page).toHaveURL(/file=README\.md/);
  await expectAccessible(page);

  await tabs.getByRole('link', { name: /Docs/ }).click();
  await expect(tabs.getByRole('link', { name: /Docs/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: 'Documentation pages' })).toBeVisible();
  await expectAccessible(page);

  await tabs.getByRole('link', { name: /Changes/ }).click();
  await expect(tabs.getByRole('link', { name: /Changes/ })).toHaveAttribute('aria-current', 'page');
  await expectAccessible(page);
});
