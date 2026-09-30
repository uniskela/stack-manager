import { getContainer } from '@/server/container';
import { CredentialActions } from '@/ui/credential-actions';
import { LocalTime } from '@/ui/local-time';
import { ButtonLink } from '@/ui/primitives/button';
import { SectionTitle } from '@/ui/primitives/section';
import { StatusPill } from '@/ui/primitives/status-pill';

export default async function SettingsCredentialsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const container = getContainer();
  const [credentials, repositories] = await Promise.all([
    container.credentials.list(workspaceId),
    container.repositories.list(workspaceId),
  ]);
  const inUse = new Set(repositories.map((r) => r.credential?.id).filter(Boolean));
  const connectHref = `/w/${workspaceId}/repositories/new`;

  return (
    <>
      <SectionTitle
        id="ws-credentials"
        title="Provider credentials"
        aside="Encrypted at rest · never shown after saving"
      />
      {credentials.length === 0 ? (
        <div className="stack gap">
          <p className="muted">No credentials yet. Tokens added while connecting a repository appear here.</p>
          <ButtonLink variant="primary" href={connectHref}>
            Connect repository
          </ButtonLink>
        </div>
      ) : (
        <ul className="list" aria-labelledby="ws-credentials">
          {credentials.map((c) => {
            const usedBy = repositories.filter((r) => r.credential?.id === c.id).map((r) => r.name);
            return (
              <li key={c.id} className="list-row wrap">
                <div className="grow">
                  <div className="title">{c.label}</div>
                  <div className="list-row-sub">
                    {c.kind} · {c.providerType} · <span className="mono">{c.hint}</span>
                    {c.meta.username ? ` · user ${c.meta.username}` : ''} · updated{' '}
                    <LocalTime iso={c.updatedAt} />
                  </div>
                  {usedBy.length > 0 ? (
                    <div className="list-row-sub">
                      Used by{' '}
                      {usedBy.map((name, i) => (
                        <span key={name}>
                          {i > 0 ? ', ' : null}
                          {name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {c.lastTestStatus ? (
                    <div className="list-row-sub">
                      <StatusPill status={c.lastTestStatus} /> <LocalTime iso={c.lastTestedAt} />
                    </div>
                  ) : null}
                </div>
                <CredentialActions
                  workspaceId={workspaceId}
                  credentialId={c.id}
                  allowDelete={!inUse.has(c.id)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
