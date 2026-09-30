import { requireSession } from '@/app/_lib/session';
import { getContainer } from '@/server/container';
import { ChangePasswordForm } from '@/ui/account/change-password-form';
import { SessionsPanel } from '@/ui/account/sessions-panel';
import { Section } from '@/ui/primitives/section';
import { SectionTitle } from '@/ui/primitives/section';

export default async function SettingsAccountPage() {
  const session = await requireSession();
  const sessions = await getContainer().auth.listSessions(session.user.id, session.session.id);

  return (
    <div className="stack gap">
      <Section id="ws-account-password" title="Password">
        <ChangePasswordForm />
      </Section>
      <SectionTitle
        id="ws-account-sessions"
        title="Active sessions"
        aside="Use Sign out in the sidebar to end this browser session"
      />
      <SessionsPanel initialSessions={sessions} />
    </div>
  );
}
