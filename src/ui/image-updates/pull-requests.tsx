'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ImageUpdatePullReview, ImageUpdatePullReviewList } from '@/shared/image-update-pull-review';
import { api, ApiError } from '@/ui/api';
import { Alert } from '@/ui/primitives/alert';
import { Button, ButtonLink } from '@/ui/primitives/button';
import { ConfirmButton } from '@/ui/primitives/confirm-button';
import { Section } from '@/ui/primitives/section';

const checkLabels = {
  success: 'Checks passed',
  pending: 'Checks running',
  failure: 'Checks failed',
  missing: 'Checks unavailable',
};

export function ImageUpdatePullRequests({
  workspaceId,
  queue,
}: {
  workspaceId: string;
  queue: ImageUpdatePullReviewList;
}) {
  const router = useRouter();
  const [refreshing, refresh] = useTransition();
  const [merging, setMerging] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  async function merge({ repositoryId, number, headSha }: ImageUpdatePullReview) {
    setMerging(`${repositoryId}:${number}`);
    setNotice(null);
    try {
      await api(`/api/workspaces/${workspaceId}/image-updates/pulls`, {
        method: 'POST',
        body: { repositoryId, number, headSha },
      });
      setNotice({ ok: true, text: `Merged update pull request #${number}.` });
    } catch (error) {
      setNotice({
        ok: false,
        text: error instanceof ApiError ? error.message : 'Could not reach Stack Manager.',
      });
    } finally {
      setMerging(null);
      refresh(() => router.refresh());
    }
  }

  return (
    <Section id="image-update-pull-requests" title="Update pull requests">
      {notice ? (
        <Alert tone={notice.ok ? 'ok' : 'error'} role="status">
          {notice.text}
        </Alert>
      ) : null}
      {queue.unreadableRepositories ? <p>Could not read every Gitea repository.</p> : null}
      {queue.pulls.length ? (
        <ul className="stack">
          {queue.pulls.map((pull) => {
            const key = `${pull.repositoryId}:${pull.number}`;
            return (
              <li className="stack" key={key}>
                <strong>
                  {pull.repositoryName} · #{pull.number}
                </strong>
                <span>
                  {pull.status === 'review' ? 'Needs review · ' : ''}
                  {checkLabels[pull.checkStatus]}
                </span>
                <div className="actions">
                  <ButtonLink href={pull.url} size="sm">
                    Review pull request
                  </ButtonLink>
                  {pull.ready ? (
                    <ConfirmButton
                      label="Merge update"
                      confirmLabel="Confirm merge"
                      description="Merge this image update into the tracked branch."
                      size="sm"
                      loading={merging === key}
                      disabled={refreshing || (merging !== null && merging !== key)}
                      onConfirm={() => merge(pull)}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">No open update pull requests.</p>
      )}
      <div className="actions">
        <Button
          disabled={merging !== null}
          loading={refreshing}
          onClick={() => refresh(() => router.refresh())}
        >
          Refresh checks
        </Button>
      </div>
    </Section>
  );
}
