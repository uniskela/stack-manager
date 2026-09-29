import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { languageFor } from '@/shared/source/paths';
import { Section } from '@/ui/primitives/section';
import { DeleteStack, StackSettingsForm } from '@/ui/source/stack-settings';

export const metadata: Metadata = { title: 'Stack settings' };

export default async function StackSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; stackId: string }>;
}) {
  const { workspaceId, stackId } = await params;
  const { stacks, source } = getContainer();
  const stack = await stacks.get(workspaceId, stackId);
  const tree = await source.tree(workspaceId, stack.repository.id, stack.rootPath);
  const yamlFiles = tree.entries
    .filter((e) => e.kind === 'file' && !e.locked && e.draft !== 'new' && languageFor(e.path) === 'yaml')
    .map((e) => e.path);
  const candidates = yamlFiles.includes(stack.composePath) ? yamlFiles : [stack.composePath, ...yamlFiles];

  return (
    <div className="narrow stack">
      <Section id="stack-general" title="General">
        <StackSettingsForm
          workspaceId={workspaceId}
          stackId={stackId}
          name={stack.name}
          composePath={stack.composePath}
          composeCandidates={candidates}
        />
      </Section>
      <Section
        id="stack-scope"
        title="Scope"
        description="The folder is fixed once a stack exists. To use a different folder, add another stack from the repository page."
      >
        <dl className="meta-grid">
          <dt>Folder</dt>
          <dd className="mono">{stack.rootPath || '(repository root)'}</dd>
          <dt>Slug</dt>
          <dd className="mono">{stack.slug}</dd>
        </dl>
      </Section>
      <Section id="stack-danger" title="Danger zone">
        <DeleteStack workspaceId={workspaceId} stackId={stackId} />
      </Section>
    </div>
  );
}
