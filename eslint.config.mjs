import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

/**
 * Module boundaries for the modular monolith (docs/adr/0004-modular-monolith.md).
 * The domain layer stays free of persistence, provider, framework and UI imports.
 */
const layerRule = (patterns) => ['error', { patterns }];
const inlineStyle = 'Use a class from src/app/styles (backed by the design tokens) instead of inline styles.';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
    'playwright-report/**',
    'test-results/**',
    'out/**',
    'build/**',
    'coverage/**',
    'data/**',
    'next-env.d.ts',
  ]),
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    files: ['src/server/domain/**'],
    rules: {
      'no-restricted-imports': layerRule([
        {
          group: [
            '@/server/persistence/*',
            '@/server/providers/*',
            '@/server/application/*',
            '@/app/*',
            '@/ui/*',
            'next/*',
            'react',
            'drizzle-orm*',
            'better-sqlite3',
          ],
          message: 'The domain layer must not depend on persistence, providers, services, frameworks or UI.',
        },
      ]),
    },
  },
  {
    files: ['src/server/application/**'],
    rules: {
      'no-restricted-imports': layerRule([
        {
          group: [
            '@/server/persistence/sqlite*',
            '@/server/persistence/schema*',
            'drizzle-orm*',
            'better-sqlite3',
            '@/app/*',
            '@/ui/*',
            'next/*',
          ],
          message: 'Application services depend on ports, not on Drizzle/SQLite or the web layer.',
        },
      ]),
    },
  },
  {
    // Styling goes through the design tokens and classes in src/app/styles (docs/plans/UI_UX_PLAN.md).
    files: ['src/**/*.tsx'],
    rules: {
      'react/forbid-dom-props': ['error', { forbid: [{ propName: 'style', message: inlineStyle }] }],
      'react/forbid-component-props': ['error', { forbid: [{ propName: 'style', message: inlineStyle }] }],
    },
  },
  {
    files: ['src/shared/**'],
    rules: {
      'no-restricted-imports': layerRule([
        {
          group: ['@/server/*', '@/ui/*', '@/app/*', 'next/*', 'react', 'node:*'],
          message: 'src/shared is pure code used by both the server and the browser.',
        },
      ]),
    },
  },
  {
    files: ['src/ui/**', 'src/app/**/*-client.tsx'],
    rules: {
      'no-restricted-imports': layerRule([
        { group: ['@/server/*'], message: 'Client UI must not import server modules.' },
      ]),
    },
  },
  {
    files: ['scripts/**', 'tests/**', '**/*.test.ts'],
    rules: { 'no-console': 'off' },
  },
]);
