import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveRepositoryFetchPolicy } from '@/server/domain/repository-fetch-policy';
import { createSqliteRepositories } from '@/server/persistence/sqlite/repositories';
import { openSqlite, runMigrations } from '@/server/persistence/sqlite/database';

const dirs: string[] = [];
const tmpDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-mig-'));
  dirs.push(dir);
  return path.join(dir, 'data', 'db.sqlite');
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('migrations', () => {
  it('create the schema from an empty database and are idempotent', () => {
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
      'deployment_attempts',
      'deployment_bindings',
      'git_repository_connections',
      'git_webhook_deliveries',
      'jobs',
      'provider_credentials',
      'sessions',
      'source_drafts',
      'stacks',
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

  it('upgrades the existing 0008 schema without modifying earlier migrations', () => {
    const file = tmpDb();
    const folder = path.join(path.dirname(file), 'migration-0008');
    fs.mkdirSync(path.join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(fs.readFileSync('drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 8);
    fs.writeFileSync(path.join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const { tag } of journal.entries)
      fs.copyFileSync(`drizzle/${tag}.sql`, path.join(folder, `${tag}.sql`));
    const old = openSqlite(file);
    try {
      runMigrations(old.db, folder);
      old.db.$client.exec("INSERT INTO workspaces VALUES ('retained','Home','home',1000,2000)");
    } finally {
      old.close();
    }
    const upgraded = openSqlite(file);
    try {
      runMigrations(upgraded.db);
      expect(upgraded.db.$client.prepare('SELECT id FROM workspaces').get()).toEqual({ id: 'retained' });
      expect(upgraded.db.$client.prepare('SELECT COUNT(*) AS n FROM deployment_bindings').get()).toEqual({
        n: 0,
      });
      expect(upgraded.db.$client.prepare('SELECT COUNT(*) AS n FROM deployment_attempts').get()).toEqual({
        n: 0,
      });
    } finally {
      upgraded.close();
    }
  });
  it('upgrades a populated PR #59 database without changing history and survives reopening', async () => {
    const file = tmpDb();
    const previous = path.join(path.dirname(file), 'previous-migrations');
    fs.mkdirSync(path.join(previous, 'meta'), { recursive: true });
    const journal = JSON.parse(fs.readFileSync('drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 5);
    fs.writeFileSync(path.join(previous, 'meta/_journal.json'), JSON.stringify(journal));
    for (const { tag } of journal.entries)
      fs.copyFileSync(`drizzle/${tag}.sql`, path.join(previous, `${tag}.sql`));
    const tables = [
      'workspaces',
      'users',
      'sessions',
      'provider_credentials',
      'git_repository_connections',
      'source_drafts',
      'stacks',
      'audit_events',
      'jobs',
    ];
    let before: unknown[][];
    const old = openSqlite(file);
    try {
      runMigrations(old.db, previous);
      old.db.$client.exec(`
        INSERT INTO workspaces VALUES ('w', 'Home', 'home', 1000, 2000);
        INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('u', 'admin', 'hash', 'admin', 1000, 2000);
        INSERT INTO sessions VALUES ('session', 'u', 1000, 2000, 9000, 'browser');
        INSERT INTO provider_credentials (id, workspace_id, kind, provider_type, label, secret_ciphertext, secret_nonce, secret_key_version, secret_hint, secret_meta, created_at, updated_at) VALUES ('c', 'w', 'git', 'github', 'Token', 'synthetic-ciphertext', 'synthetic-nonce', 1, 'hint', '{}', 1000, 2000);
        INSERT INTO git_repository_connections (id, workspace_id, name, git_provider_type, remote_url, default_branch, credential_id, local_clone_path, sync_status, last_sync_error, head_sha, last_fetched_at, created_at, updated_at, last_sync_attempt_at, last_sync_failed_at, last_head_changed_at) VALUES ('r', 'w', 'Infra', 'github', 'https://example.test/infra.git', 'main', 'c', 'repos/r', 'error', 'failure', 'retained-head', 3000, 1000, 4000, 3500, 4000, 3000);
        INSERT INTO source_drafts VALUES ('draft', 'w', 'r', 'compose.yaml', 'saved draft', 'blob', 'retained-commit', 'u', 'u', 1000, 2000);
        INSERT INTO stacks VALUES ('stack', 'w', 'r', 'Stack', 'stack', '', 'compose.yaml', 1000, 2000);
        INSERT INTO audit_events VALUES ('event', 2000, 'u', 'w', 'repository.sync', 'success', 'repository', 'r', '{}');
        INSERT INTO jobs (id, type, payload, status, run_after, attempts, max_attempts, last_error, lease_owner, lease_expires_at, dedupe_key, created_at, updated_at, follow_up_requested) VALUES ('job', 'repository_sync', '{"repositoryId":"r"}', 'running', 4000, 2, 5, 'retry', 'worker', 5000, 'repository_sync:r', 1000, 4000, 1);
      `);
      before = tables.map((table) => old.db.$client.prepare(`SELECT * FROM ${table}`).all());
    } finally {
      old.close();
    }
    const upgraded = openSqlite(file);
    try {
      runMigrations(upgraded.db);
      runMigrations(upgraded.db);
      tables.forEach((table, index) => {
        const rows = upgraded.db.$client.prepare(`SELECT * FROM ${table}`).all();
        expect(rows).toEqual(
          table === 'git_repository_connections'
            ? before[index]!.map((row) => ({
                ...(row as object),
                auto_fetch_enabled: 1,
                auto_fetch_interval_minutes: null,
              }))
            : before[index],
        );
      });
      const repository = (await createSqliteRepositories(upgraded.db).gitRepositories.findById('w', 'r'))!;
      for (const interval of [15, 30]) {
        expect(
          resolveRepositoryFetchPolicy(repository, {
            workerEnabled: true,
            autoFetchEnabled: true,
            autoFetchIntervalMinutes: interval,
          }),
        ).toMatchObject({ enabled: true, intervalMinutes: interval });
      }
      expect(upgraded.db.$client.pragma('foreign_key_check')).toEqual([]);
    } finally {
      upgraded.close();
    }
    const reopened = openSqlite(file);
    try {
      runMigrations(reopened.db);
      expect(
        (await createSqliteRepositories(reopened.db).gitRepositories.findById('w', 'r'))!
          .autoFetchIntervalMinutes,
      ).toBeNull();
    } finally {
      reopened.close();
    }
  });

  it('creates the database file with owner-only permissions', () => {
    const file = tmpDb();
    const handle = openSqlite(file);
    handle.close();
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(fs.statSync(path.dirname(file)).mode & 0o077).toBe(0);
  });
});
