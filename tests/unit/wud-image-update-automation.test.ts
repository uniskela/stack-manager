import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '@/server/application/audit-service';
import { IMAGE_UPDATE_POLICY_PATH } from '@/server/application/image-update-policy';
import type { ImageUpdateService } from '@/server/application/image-update-service';
import type { SourceService } from '@/server/application/source-service';
import { WudImageUpdateAutomation } from '@/server/application/wud-image-update-automation';
import { NotFoundError } from '@/server/domain/errors';
import type { Stack } from '@/server/domain/stack';
import { MAX_IMAGE_UPDATE_CANDIDATES } from '@/shared/image-update-planning';
import type { StackImageUpdate } from '@/shared/image-updates';
import type { FileView } from '@/shared/source/types';

const workspaceId = 'workspace';
const publish = { mode: 'publish', author: { name: 'Bot', email: 'bot@example.org' } };

function stack(id: string, repositoryId = 'repo'): Stack {
  return {
    id,
    workspaceId,
    repositoryId,
    name: id,
    slug: id,
    rootPath: id,
    composePath: `${id}/compose.yml`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function policy(config: Record<string, unknown>): FileView {
  const content = JSON.stringify({ version: 1, ...config });
  return {
    path: IMAGE_UPDATE_POLICY_PATH,
    language: 'json',
    commitSha: 'a'.repeat(40),
    blobSha: 'b'.repeat(40),
    size: Buffer.byteLength(content),
    content,
    editable: true,
    locked: null,
    draft: null,
  };
}

function suggestion(name: string, status: StackImageUpdate['status'] = 'available'): StackImageUpdate {
  return { name, status, image: 'example/app:1.2.3', candidateTag: '1.2.4' };
}

function arrange(stacks: Stack[], policies: Record<string, FileView>) {
  const list = vi.fn().mockResolvedValue(stacks);
  const readFile = vi.fn<SourceService['readFile']>().mockImplementation(async (_, repositoryId) => {
    const file = policies[repositoryId];
    if (!file) throw new NotFoundError();
    return file;
  });
  const queue = vi.fn<ImageUpdateService['queue']>().mockResolvedValue({
    unboundCount: 0,
    inventory: stacks.map(({ id, name }) => ({
      stackId: id,
      stackName: name,
      binding: { watcher: 'local', project: name },
      sourceStatus: 'ready',
      images: [suggestion('app')],
    })),
  });
  const runAutomatic = vi
    .fn<ConstructorParameters<typeof WudImageUpdateAutomation>[3]['runAutomatic']>()
    .mockResolvedValue('ready');
  const record = vi.fn<AuditService['record']>().mockResolvedValue();
  const warn = vi.fn();
  const automation = new WudImageUpdateAutomation(
    { list },
    { readFile },
    { queue },
    { runAutomatic },
    { record },
    { warn },
  );
  return { automation, record, readFile, queue, runAutomatic, warn };
}

describe('WUD image update automation', () => {
  it('requires committed opt-in and honors the WUD source setting', async () => {
    const draft = policy({ automation: publish });
    const { automation, queue, record, runAutomatic } = arrange(
      [stack('no-policy', 'missing'), stack('draft-policy', 'draft'), stack('disabled-wud', 'disabled')],
      {
        draft: {
          ...draft,
          blobSha: null,
          content: null,
          draft: { content: draft.content!, updatedAt: '', baseBlobSha: null, outdated: false },
        },
        disabled: policy({ sources: { wud: false }, automation: publish }),
      },
    );

    await automation.run(workspaceId, new AbortController().signal);
    expect(queue).not.toHaveBeenCalled();
    expect(runAutomatic).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('records a report by planning eligible candidates with publication disabled', async () => {
    const { automation, readFile, runAutomatic, record } = arrange([stack('app'), stack('cache')], {
      repo: policy({ automation: { mode: 'report' }, exclude: [{ path: 'cache/compose.yml' }] }),
    });

    const signal = new AbortController().signal;
    await automation.run(workspaceId, signal);
    expect(readFile).toHaveBeenCalledExactlyOnceWith(workspaceId, 'repo', '', IMAGE_UPDATE_POLICY_PATH);
    expect(runAutomatic).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      'app',
      [{ stackId: 'app', service: 'app', source: 'wud', targetTag: '1.2.4' }],
      signal,
      true,
    );
    expect(record).toHaveBeenCalledExactlyOnceWith({
      action: 'wud.image_update_checked',
      entityType: 'stack',
      entityId: 'app',
      workspaceId,
      outcome: 'success',
      meta: { mode: 'report', result: 'ready', candidateCount: 1 },
    });
  });

  it('passes at most 24 available candidates to the planner and audits its result', async () => {
    const signal = new AbortController().signal;
    const { automation, queue, runAutomatic, record } = arrange([stack('app')], {
      repo: policy({ automation: publish }),
    });
    const ready = (await queue(workspaceId)).inventory[0]!;
    queue.mockResolvedValue({
      unboundCount: 0,
      inventory: [
        {
          ...ready,
          sourceStatus: 'ready',
          images: [
            suggestion('stale', 'stale'),
            { ...suggestion('digest'), candidateTag: null },
            ...Array.from({ length: MAX_IMAGE_UPDATE_CANDIDATES + 1 }, (_, index) =>
              suggestion(`app-${index}`),
            ),
          ],
        },
      ],
    });
    runAutomatic.mockResolvedValue('review');

    await automation.run(workspaceId, signal);
    expect(runAutomatic).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      'app',
      Array.from({ length: MAX_IMAGE_UPDATE_CANDIDATES }, (_, index) => ({
        stackId: 'app',
        service: `app-${index}`,
        source: 'wud',
        targetTag: '1.2.4',
      })),
      signal,
      false,
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ meta: { mode: 'publish', result: 'review', candidateCount: 24 } }),
    );
  });

  it('continues after a failed stack and runs no further publication in a repository after one succeeds', async () => {
    const { automation, runAutomatic, record, warn } = arrange(
      [stack('failed'), stack('published'), stack('later'), stack('separate', 'other')],
      { repo: policy({ automation: publish }), other: policy({ automation: publish }) },
    );
    runAutomatic
      .mockRejectedValueOnce(new Error('Temporary planner error'))
      .mockResolvedValueOnce('published');

    await automation.run(workspaceId, new AbortController().signal);
    expect(runAutomatic.mock.calls.map(([, stackId]) => stackId)).toEqual([
      'failed',
      'published',
      'separate',
    ]);
    expect(
      record.mock.calls.map(([{ entityId, outcome, meta }]) => [entityId, outcome, meta?.result]),
    ).toEqual([
      ['failed', 'failure', 'failed'],
      ['published', 'success', 'published'],
      ['later', 'success', 'skipped'],
      ['separate', 'success', 'ready'],
    ]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('stops before running a second stack when the refresh job is aborted', async () => {
    const controller = new AbortController();
    const { automation, runAutomatic } = arrange([stack('app'), stack('cache')], {
      repo: policy({ automation: publish }),
    });
    const reason = new Error('Refresh stopped');
    runAutomatic.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw reason;
    });

    await expect(automation.run(workspaceId, controller.signal)).rejects.toBe(reason);
    expect(runAutomatic).toHaveBeenCalledTimes(1);
  });
});
