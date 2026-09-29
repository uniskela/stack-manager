import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite, runMigrations } from '@/server/persistence/sqlite/database';

const dirs: string[] = [];
const tmpDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-mig-'));
  dirs.push(dir);
  return path.join(dir, 'data', 'db.sqlite');
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('migrations', () => {
  it('create the foundation schema from an empty database and are idempotent', () => {
    const file = tmpDb();
    const handle = openSqlite(file);
    runMigrations(handle.db);
    runMigrations(handle.db); // second run is a no-op
    const client = handle.db.$client;
    const tables = client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual([
      'audit_events',
      'git_repository_connections',
      'jobs',
      'provider_credentials',
      'sessions',
      'users',
      'workspaces',
    ]);
    const jobCols = client
      .prepare('PRAGMA table_info(jobs)')
      .all()
      .map((r) => (r as { name: string }).name);
    for (const col of [
      'status',
      'run_after',
      'attempts',
      'lease_owner',
      'lease_expires_at',
      'heartbeat_at',
      'acceptance_recorded_at',
    ]) {
      expect(jobCols).toContain(col);
    }
    const credCols = client
      .prepare('PRAGMA table_info(provider_credentials)')
      .all()
      .map((r) => (r as { name: string }).name);
    expect(credCols).toEqual(
      expect.arrayContaining(['secret_ciphertext', 'secret_nonce', 'secret_key_version']),
    );
    expect(credCols.some((c) => /plain/i.test(c))).toBe(false);
    expect(client.pragma('foreign_keys', { simple: true })).toBe(1);
    handle.close();
  });

  it('creates the database file with owner-only permissions', () => {
    const file = tmpDb();
    const handle = openSqlite(file);
    handle.close();
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(fs.statSync(path.dirname(file)).mode & 0o077).toBe(0);
  });
});
