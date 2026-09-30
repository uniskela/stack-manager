import type { Metadata } from 'next';
import { PageHeader } from '@/ui/primitives/page-header';
import { SettingsNav } from '@/ui/settings/settings-nav';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const base = `/w/${workspaceId}/settings`;

  return (
    <div className="stack">
      <div className="stack-head">
        <PageHeader title="Settings" />
        <SettingsNav base={base} />
      </div>
      {children}
    </div>
  );
}
