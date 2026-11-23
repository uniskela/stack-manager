import { and, eq, lte, ne } from 'drizzle-orm';
import type { WudBinding } from '@/shared/image-updates';
import type { WudConnection, WudRepository } from '@/server/application/wud-ports';
import type { CredentialRecord } from '@/server/domain/credential';
import { ConflictError } from '@/server/domain/errors';
import { providerCredentials, wudConnections, wudStackBindings } from '../schema';
import type { SqliteDb } from './database';

const changed = () => new ConflictError('The WUD connection changed. Reload and try again.');

export class SqliteWudRepository implements WudRepository {
  constructor(private readonly db: SqliteDb) {}

  async connection(workspaceId: string) {
    return (
      this.db.select().from(wudConnections).where(eq(wudConnections.workspaceId, workspaceId)).get() ?? null
    );
  }

  async dueConnections(before: Date) {
    return this.db
      .select({ workspaceId: wudConnections.workspaceId, revision: wudConnections.revision })
      .from(wudConnections)
      .where(lte(wudConnections.lastAttemptAt, before))
      .all();
  }

  async saveConnection(
    connection: WudConnection,
    credential: CredentialRecord,
    expectedRevision: string | null,
  ) {
    this.db.transaction((tx) => {
      const current = tx
        .select()
        .from(wudConnections)
        .where(eq(wudConnections.workspaceId, connection.workspaceId))
        .get();
      if ((current?.revision ?? null) !== expectedRevision) throw changed();
      tx.insert(providerCredentials).values(credential).run();
      if (!current) {
        tx.insert(wudConnections).values(connection).run();
      } else {
        tx.update(wudConnections)
          .set(connection)
          .where(eq(wudConnections.workspaceId, current.workspaceId))
          .run();
        tx.delete(providerCredentials).where(eq(providerCredentials.id, current.credentialId)).run();
      }
    });
  }

  async removeConnection(workspaceId: string, expectedRevision: string): Promise<void> {
    this.db.transaction((tx) => {
      const current = tx
        .select()
        .from(wudConnections)
        .where(eq(wudConnections.workspaceId, workspaceId))
        .get();
      if (!current || current.revision !== expectedRevision) throw changed();
      tx.delete(wudConnections).where(eq(wudConnections.workspaceId, workspaceId)).run();
      tx.delete(providerCredentials).where(eq(providerCredentials.id, current.credentialId)).run();
    });
  }

  async recordRefresh(
    workspaceId: string,
    revision: string,
    at: Date,
    result: Parameters<WudRepository['recordRefresh']>[3],
  ) {
    this.db
      .update(wudConnections)
      .set(
        'observations' in result
          ? { observations: result.observations, lastSuccessAt: at, lastAttemptAt: at, lastError: null }
          : { lastAttemptAt: at, lastError: result.error },
      )
      .where(
        and(
          eq(wudConnections.workspaceId, workspaceId),
          eq(wudConnections.revision, revision),
          lte(wudConnections.lastAttemptAt, at),
        ),
      )
      .run();
  }

  async bindings(workspaceId: string) {
    return this.db.select().from(wudStackBindings).where(eq(wudStackBindings.workspaceId, workspaceId)).all();
  }

  async setBinding(workspaceId: string, stackId: string, binding: WudBinding | null) {
    if (!binding) {
      this.db
        .delete(wudStackBindings)
        .where(and(eq(wudStackBindings.workspaceId, workspaceId), eq(wudStackBindings.stackId, stackId)))
        .run();
      return;
    }
    this.db.transaction((tx) => {
      const duplicate = tx
        .select({ id: wudStackBindings.stackId })
        .from(wudStackBindings)
        .where(
          and(
            eq(wudStackBindings.workspaceId, workspaceId),
            eq(wudStackBindings.watcher, binding.watcher),
            eq(wudStackBindings.project, binding.project),
            ne(wudStackBindings.stackId, stackId),
          ),
        )
        .get();
      if (duplicate)
        throw new ConflictError('This watcher and Compose project are already matched to another stack.');
      tx.insert(wudStackBindings)
        .values({ workspaceId, stackId, ...binding })
        .onConflictDoUpdate({ target: wudStackBindings.stackId, set: binding })
        .run();
    });
  }
}
