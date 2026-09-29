import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const ADMIN = { username: 'admin', password: 'e2e correct horse battery staple' };
export const WORKSPACE_NAME = 'Homelab';
export const AUTH_STATE = 'test-results/.auth/admin.json';
export const SAMPLE_STATE = 'test-results/.auth/sample.json';
/** Public HTTPS repository used by the source workspace tests (it must be reachable without credentials). */
export const SAMPLE_REMOTE = process.env.E2E_GIT_REMOTE ?? '';
/** Folder of SAMPLE_REMOTE (containing a Compose file) registered as the test stack; '' is the root. */
export const SAMPLE_ROOT = process.env.E2E_STACK_ROOT ?? '';

/**
 * Fails on serious or critical WCAG 2.2 A/AA violations, in both light and dark colour schemes, since
 * the two palettes have separate contrast risks.
 */
export async function expectAccessible(page: Page) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const blocking = violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => ({ id: v.id, help: v.help, targets: v.nodes.map((n) => n.target.join(' ')) }));
    expect(blocking, `axe violations (${colorScheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: null });
}
