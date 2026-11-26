import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/archivo/standard.css';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';

// Every page reads the session or database at request time; nothing is prerendered at build time.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { default: 'stack-manager', template: '%s · stack-manager' },
  description: 'Git-native source workspace for self-hosted Compose infrastructure.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#efeef4' },
    { media: '(prefers-color-scheme: dark)', color: '#0f0b18' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
