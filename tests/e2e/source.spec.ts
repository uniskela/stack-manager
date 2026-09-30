import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { AUTH_STATE, expectAccessible, SAMPLE_REMOTE, SAMPLE_STATE } from './support';

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

  for (const tab of ['Docs', 'Environment', 'Changes', 'Settings']) {
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

  await page
    .getByRole('navigation', { name: 'Stack' })
    .getByRole('link', { name: /Changes/ })
    .click();
  await expect(page.locator('.diff')).toContainText('# edited by e2e');
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Discard…' }).click();
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await expect(page.getByRole('heading', { name: 'No draft changes' })).toBeVisible();
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
