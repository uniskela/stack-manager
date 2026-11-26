import { and, eq, isNull, lte, ne } from 'drizzle-orm';
import type { WudBinding } from '@/shared/image-updates';
import type { WudConnection, WudMappingSource, WudRepository } from '@/server/application/wud-ports';
import type { CredentialRecord } from '@/server/domain/credential';
import { ConflictError } from '@/server/domain/errors';
import {
  gitRepositoryConnections,
  providerCredentials,
  stacks,
  wudConnections,
  wudStackBindings,
} from '../schema';
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
      if (current?.revision !== expectedRevision) throw changed();
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
    const updated = this.db
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
    return updated.changes === 1;
  }

  async bindings(workspaceId: string) {
    return this.db.select().from(wudStackBindings).where(eq(wudStackBindings.workspaceId, workspaceId)).all();
  }

  async saveDiscoveredBinding(
    workspaceId: string,
    snapshot: Pick<WudConnection, 'revision' | 'lastSuccessAt'>,
    source: WudMappingSource,
    binding: WudBinding,
  ): Promise<boolean> {
    return this.db.transaction((tx) => {
      const connection = tx
        .select({ id: wudConnections.workspaceId })
        .from(wudConnections)
        .where(
          and(
            eq(wudConnections.workspaceId, workspaceId),
            eq(wudConnections.revision, snapshot.revision),
            eq(wudConnections.lastSuccessAt, snapshot.lastSuccessAt),
            isNull(wudConnections.lastError),
          ),
        )
        .get();
      if (!connection) return false;
      const stack = tx
        .select({ id: stacks.id })
        .from(stacks)
        .innerJoin(gitRepositoryConnections, eq(gitRepositoryConnections.id, stacks.repositoryId))
        .where(
          and(
            eq(stacks.id, source.id),
            eq(stacks.workspaceId, workspaceId),
            eq(stacks.repositoryId, source.repositoryId),
            eq(stacks.rootPath, source.rootPath),
            eq(stacks.composePath, source.composePath),
            eq(gitRepositoryConnections.workspaceId, workspaceId),
            eq(gitRepositoryConnections.headSha, source.commitSha),
          ),
        )
        .get();
      if (!stack) return false;
      const inserted = tx
        .insert(wudStackBindings)
        .values({ workspaceId, stackId: stack.id, watcher: binding.watcher, project: binding.project })
        .onConflictDoNothing()
        .run();
      return inserted.changes > 0;
    });
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
