import { KeyRound, Variable } from 'lucide-react';
import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { analyzeCompose, parseEnvTemplate } from '@/shared/source/compose';
import {
  basename,
  dirname,
  isEnvTemplateName,
  joinRepoPath,
  normalizeRepoPath,
  relativeTo,
} from '@/shared/source/paths';
import { Alert } from '@/ui/primitives/alert';
import { TableWrap } from '@/ui/primitives/table-wrap';
import { EmptyState } from '@/ui/primitives/empty-state';
import { SectionTitle } from '@/ui/primitives/section';

export const metadata: Metadata = { title: 'Environment' };

/**
 * Environment inventory derived from source only (docs/STACK_DISCOVERY.md): variables referenced by the
 * Compose file, whether `.env.example` documents them, and env files the stack expects. Values are
 * never read; secret files are only listed.
 */
export default async function StackEnvironmentPage({
  params,
}: {
  params: Promise<{ workspaceId: string; stackId: string }>;
}) {
  const { workspaceId, stackId } = await params;
  const { stacks, source } = getContainer();
  const stack = await stacks.get(workspaceId, stackId);
  const repo = stack.repository.id;
  const tree = await source.tree(workspaceId, repo, stack.rootPath);
  const compose = await source.readEffective(workspaceId, repo, stack.rootPath, stack.composePath);

  if (!compose) {
    return (
      <EmptyState icon={Variable} title="Compose file unavailable">
        The Compose file for this stack could not be read at the fetched commit.
      </EmptyState>
    );
  }

  const analysis = analyzeCompose(compose.content);
  const templates = tree.entries.filter((e) => e.kind === 'file' && isEnvTemplateName(basename(e.path)));
  const documented = new Map<string, string>();
  for (const t of templates) {
    const text = await source.readEffective(workspaceId, repo, stack.rootPath, t.path);
    for (const name of parseEnvTemplate(text?.content ?? '')) {
      if (!documented.has(name)) documented.set(name, relativeTo(stack.rootPath, t.path));
    }
  }

  const variables = new Map<string, { lines: number[]; hasDefault: boolean; required: boolean }>();
  for (const v of analysis.variables) {
    const entry = variables.get(v.name) ?? { lines: [], hasDefault: false, required: false };
    if (!entry.lines.includes(v.line)) entry.lines.push(v.line);
    entry.hasDefault ||= v.hasDefault;
    entry.required ||= v.required;
    variables.set(v.name, entry);
  }
  const unused = [...documented.keys()].filter((n) => !variables.has(n));
  const secretFiles = tree.entries.filter((e) => e.locked === 'secret');
  const composeDir = dirname(stack.composePath);
  const envFiles = analysis.envFiles.map((ref) => {
    let path: string | null = null;
    try {
      path = normalizeRepoPath(joinRepoPath(composeDir, ref));
    } catch {
      path = null;
    }
    const entry = path ? tree.entries.find((e) => e.path === path) : undefined;
    return { ref, entry };
  });
  const hardcoded = analysis.problems.filter((pr) => pr.code === 'hardcoded-secret');
  const undocumented = [...variables.entries()].filter(([n, v]) => !documented.has(n) && !v.hasDefault);

  return (
    <div className="stack">
      {compose.fromDraft ? (
        <Alert tone="info">This inventory reflects your unsaved-to-Git draft of the Compose file.</Alert>
      ) : null}
      {secretFiles.length > 0 ? (
        <Alert tone="warn" title="Secret files are committed to this repository">
          {secretFiles.map((f) => relativeTo(stack.rootPath, f.path)).join(', ')}{' '}
          {secretFiles.length === 1 ? 'is' : 'are'} stored in Git. stack-manager never shows or edits these
          files. Consider removing them from the repository and documenting the variables in .env.example
          instead.
        </Alert>
      ) : null}

      {hardcoded.length > 0 ? (
        <Alert
          tone="warn"
          title={`${hardcoded.length} value${hardcoded.length === 1 ? ' looks' : 's look'} like hard-coded secrets`}
        >
          Lines {hardcoded.map((pr) => pr.line).join(', ')} of the Compose file set password- or token-like
          keys to literal values, so anyone who can read the repository can read them. Replace them with
          variables such as <code>{'${DB_PASSWORD}'}</code> and provide the values at deploy time.
        </Alert>
      ) : null}

      <SectionTitle
        id="env-vars"
        title="Variables referenced"
        aside={
          templates.length
            ? `Documented in ${templates.map((t) => relativeTo(stack.rootPath, t.path)).join(', ')}`
            : 'No .env.example found'
        }
      />
      {variables.size === 0 ? (
        <p className="muted">The Compose file does not reference any {'${VARIABLES}'}.</p>
      ) : (
        <TableWrap labelledBy="env-vars">
          <table className="simple" aria-labelledby="env-vars">
            <thead>
              <tr>
                <th scope="col">Variable</th>
                <th scope="col">Lines</th>
                <th scope="col">Behaviour</th>
                <th scope="col">Documented</th>
              </tr>
            </thead>
            <tbody>
              {[...variables.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([name, v]) => (
                  <tr key={name}>
                    <td className="mono">{name}</td>
                    <td>{v.lines.join(', ')}</td>
                    <td>
                      {v.required ? (
                        <span className="pill failed">Required</span>
                      ) : v.hasDefault ? (
                        <span className="pill">Has default</span>
                      ) : (
                        <span className="pill pending">Empty if unset</span>
                      )}
                    </td>
                    <td>
                      {documented.has(name) ? (
                        <span className="pill ok">{documented.get(name)}</span>
                      ) : (
                        <span className="muted">Not documented</span>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {undocumented.length > 0 ? (
        <Alert
          tone="warn"
          title={`${undocumented.length} variable${undocumented.length === 1 ? '' : 's'} without a default or documentation`}
        >
          Add {undocumented.map(([n]) => n).join(', ')} to .env.example so whoever deploys this stack knows to
          set {undocumented.length === 1 ? 'it' : 'them'}.
        </Alert>
      ) : null}
      {unused.length > 0 ? (
        <p className="fine-print">Documented but not referenced by the Compose file: {unused.join(', ')}.</p>
      ) : null}

      <SectionTitle id="env-files" title="Env files" />
      {envFiles.length === 0 ? (
        <p className="muted">No service uses env_file.</p>
      ) : (
        <ul className="list" aria-labelledby="env-files">
          {envFiles.map(({ ref, entry }) => (
            <li key={ref} className="list-row">
              <KeyRound className="icon muted" aria-hidden="true" />
              <span className="grow mono">{ref}</span>
              {entry?.locked === 'secret' ? (
                <span className="pill failed">Committed to Git</span>
              ) : entry ? (
                <span className="pill ok">In repository</span>
              ) : (
                <span className="pill">Provided at deploy time</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <SectionTitle
        id="env-services"
        title="Service environment keys"
        aside="Names only, values are never shown"
      />
      {analysis.services.length === 0 ? (
        <p className="muted">No services found.</p>
      ) : (
        <TableWrap labelledBy="env-services">
          <table className="simple" aria-labelledby="env-services">
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Image</th>
                <th scope="col">Environment keys</th>
              </tr>
            </thead>
            <tbody>
              {analysis.services.map((s) => (
                <tr key={s.name}>
                  <td className="mono">{s.name}</td>
                  <td className="mono">{s.image ?? (s.build ? '(build)' : '—')}</td>
                  <td className="mono">{s.environmentKeys.length ? s.environmentKeys.join(', ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </div>
  );
}
