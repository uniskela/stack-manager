/**
 * Applies pending migrations to STACK_MANAGER_DATA_DIR without starting the server.
 * Migrations also run automatically at startup; this is for operators and CI.
 */
import { loadConfig } from '../src/server/config/config';
import { openSqlite, runMigrations } from '../src/server/persistence/sqlite/database';

const config = loadConfig();
const handle = openSqlite(config.databasePath);
try {
  runMigrations(handle.db);
  console.log(`migrations applied: ${config.databasePath}`);
} finally {
  handle.close();
}
