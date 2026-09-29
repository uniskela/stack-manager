import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

/**
 * Module boundaries for the modular monolith (docs/adr/0004-modular-monolith.md).
 * The domain layer stays free of persistence, provider, framework and UI imports.
 */
const layerRule = (patterns) => ['error', { patterns }];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'coverage/**', 'data/**', 'next-env.d.ts']),
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
