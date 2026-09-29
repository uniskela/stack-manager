import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../schema';

export type SqliteDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export interface SqliteHandle {
  db: SqliteDb;
  close(): void;
}

/**
 * Opens (creating if needed) the SQLite database. The file is created with owner-only permissions
 * because it holds session digests and credential ciphertext.
 */
export function openSqlite(databasePath: string): SqliteHandle {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(databasePath)) fs.closeSync(fs.openSync(databasePath, 'a', 0o600));
  }
  const sqlite = new Database(databasePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  const db = drizzle(sqlite, { schema });
  return { db, close: () => sqlite.close() };
}

export function defaultMigrationsFolder(): string {
  return path.join(process.cwd(), 'drizzle');
}

export function runMigrations(db: SqliteDb, migrationsFolder = defaultMigrationsFolder()): void {
  if (!fs.existsSync(path.join(migrationsFolder, 'meta', '_journal.json'))) {
    throw new Error(`Migrations folder not found at ${migrationsFolder}`);
  }
  migrate(db, { migrationsFolder });
}

/** Cheap liveness probe for the health endpoint. */
export function pingSqlite(db: SqliteDb): boolean {
  return db.$client.prepare('SELECT 1 AS ok').get() !== undefined;
}
