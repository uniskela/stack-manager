import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

/**
 * UI tests: the onboarding journey plus axe accessibility checks at desktop and mobile widths.
 * Run `pnpm build && pnpm test:e2e`. Set E2E_BASE_URL to test an already-running, not-yet-set-up instance.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    // First-run setup happens once and stores the admin session for the other projects.
    { name: 'onboarding', testMatch: /onboarding\.setup\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'desktop',
      testMatch: /\.spec\.ts/,
      // Draft-mutating Git workflow tests share the sample stack; run them after source/shell.
      testIgnore: /changes-commit\.spec\.ts/,
      dependencies: ['onboarding'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } },
    },
    {
      name: 'mobile',
      testMatch: /\.spec\.ts/,
      testIgnore: /changes-commit\.spec\.ts/,
      dependencies: ['onboarding'],
      // Pixel 7 is Chromium-based, so no WebKit download is needed.
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'git-workflow',
      testMatch: /changes-commit\.spec\.ts/,
      dependencies: ['desktop', 'mobile'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } },
    },
    {
      name: 'git-workflow-mobile',
      testMatch: /changes-commit\.spec\.ts/,
      dependencies: ['git-workflow'],
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'scripts/e2e-server.sh',
        env: { PORT: String(port) },
        url: `${baseURL}/api/health`,
        reuseExistingServer: false,
        timeout: 60_000,
      },
});
