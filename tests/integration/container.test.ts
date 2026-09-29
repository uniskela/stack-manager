import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqliteHandle } from '@/server/persistence/sqlite/database';
import { testConfig } from '../support/config';

const opened: Array<{ handle: SqliteHandle; closed: boolean }> = [];

vi.mock('@/server/persistence/sqlite/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/persistence/sqlite/database')>();
  return {
    ...actual,
    openSqlite: (file: string) => {
      const handle = actual.openSqlite(file);
      const entry = { handle, closed: false };
      opened.push(entry);
      return {
        ...handle,
        close: () => {
          entry.closed = true;
          handle.close();
        },
      };
    },
  };
});

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('createContainer', () => {
  it('closes the SQLite handle and rethrows when construction fails after opening it', async () => {
    const { createContainer } = await import('@/server/container');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-container-'));
    dirs.push(dataDir);
    expect(() =>
      createContainer(testConfig(dataDir), { migrationsFolder: path.join(dataDir, 'missing-migrations') }),
    ).toThrow(/Migrations folder not found/);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.closed).toBe(true);
  });
});
