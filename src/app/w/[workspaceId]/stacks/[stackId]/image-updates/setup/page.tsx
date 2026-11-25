import type { Metadata } from 'next';
import Link from 'next/link';
import { getContainer } from '@/server/container';
import { normalizeRemoteUrl } from '@/server/domain/git-repository';
import { WudConnectionForm, WudRefresh } from '@/ui/image-updates/forms';
import { StackWudMatch } from '@/ui/image-updates/stack-match';
import { ButtonLink } from '@/ui/primitives/button';
import { Section, SectionTitle } from '@/ui/primitives/section';
import { orNotFound } from '../../../../../../_lib/session';

export const metadata: Metadata = { title: 'Image update setup' };

export default async function ImageUpdateSetupPage({
  params,
}: Readonly<{ params: Promise<{ workspaceId: string; stackId: string }> }>) {
  const { workspaceId, stackId } = await params;
  const { stacks, repositories, imageUpdates, imageUpdateStaging, config } = getContainer();
  const [stack, settings, binding, workflow] = await Promise.all([
    orNotFound(stacks.get(workspaceId, stackId)),
    imageUpdates.settings(workspaceId),
    imageUpdates.stackBinding(workspaceId, stackId),
    imageUpdateStaging.repositoryWorkflowGuide(workspaceId, stackId).catch(() => undefined),
  ]);
  const { connection, refreshing } = settings;
  const workspace = `/w/${workspaceId}`;
  const stackPage = `${workspace}/stacks/${stackId}`;
  const filesPage = `${workspace}/repositories/${stack.repository.id}/files`;
  const repo = workflow ? await repositories.get(workspaceId, stack.repository.id) : null;
  const pullRequestsUrl = repo ? repositoryPullRequestsUrl(repo) : null;

  return (
    <div className="narrow stack">
      <SectionTitle id="image-update-setup" title="Set up image updates" />
      <Section id="wud-connection" title="1. Connect WUD (optional)">
        {connection ? (
          <div className="stack">
            <p>WUD is set up for this workspace.</p>
            <WudRefresh
              workspaceId={workspaceId}
              connection={connection}
              refreshing={refreshing}
              workerEnabled={config.workerEnabled}
            />
            <p>
              <Link href={`${workspace}/settings/wud`}>Edit the WUD connection</Link>
            </p>
          </div>
        ) : (
          <div className="stack">
            <p>
              For automatic suggestions, enter your What’s Up Docker HTTPS URL and a read-only token. You can
              also enter tags yourself on the Image updates tab.
            </p>
            <WudConnectionForm workspaceId={workspaceId} connection={null} />
          </div>
        )}
      </Section>
      <Section id="wud-mapping" title="2. Match this stack to WUD">
        {connection ? (
          <StackWudMatch workspaceId={workspaceId} stackId={stackId} binding={binding} />
        ) : (
          <p>Connect WUD above to find a match for this stack.</p>
        )}
      </Section>
      <Section id="update-destination" title="3. Where to review the update">
        {workflow === undefined ? (
          <p>Could not check this repository’s update workflow. Reload the guide to try again.</p>
        ) : null}
        {workflow ? (
          <div className="stack">
            <p>
              <strong>{stack.repository.name} uses its own WUD update workflow.</strong> It prepares Compose,
              related files, and version documentation together.
            </p>
            {workflow.skillPath ? (
              <>
                <p>
                  In Orca, start your <strong>Portainer WUD Updates</strong> job or wait for the next
                  scheduled run. Review the pull request it creates or refreshes.
                </p>
                <p>
                  To set up a runner, follow the checked-in{' '}
                  <Link href={`${filesPage}?file=${encodeURIComponent(workflow.skillPath)}`}>
                    Portainer WUD Updates instructions
                  </Link>
                  . The job uses a fresh worktree for each run and its runner handles WUD authentication.
                </p>
              </>
            ) : (
              <p>
                Run the automation that maintains{' '}
                <Link href={`${filesPage}?file=${encodeURIComponent(workflow.policyPath)}`}>
                  {workflow.policyPath}
                </Link>
                , then review the PR it prepares on your Git forge.
              </p>
            )}
            <div className="actions">
              {pullRequestsUrl ? (
                <ButtonLink href={pullRequestsUrl}>Open repository pull requests</ButtonLink>
              ) : null}
              <ButtonLink href={`${stackPage}/image-updates`}>Return to image preview</ButtonLink>
            </div>
          </div>
        ) : null}
        {workflow === null ? (
          <div className="stack">
            <p>
              Open Image updates to review a tag and save it as a Compose draft. Open Changes to inspect the
              draft and commit it when you’re ready.
            </p>
            <div className="actions">
              <ButtonLink href={`${stackPage}/image-updates`}>Open image updates</ButtonLink>
            </div>
          </div>
        ) : null}
      </Section>
    </div>
  );
}

function repositoryPullRequestsUrl(repo: { gitProviderType: string; remoteUrl: string }): string | null {
  if (!['github', 'gitea', 'forgejo'].includes(repo.gitProviderType)) return null;
  const url = new URL(normalizeRemoteUrl(repo.remoteUrl));
  url.pathname = url.pathname.replace(/\.git$/i, '') + '/pulls';
  return url.href;
}
