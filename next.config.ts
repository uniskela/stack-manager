import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  // Script-src hardening (nonces) is planned for the PR #8 hardening pass; these directives are safe today.
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
];

const nextConfig: NextConfig = {
  // Self-hosted, long-running Node server (see docs/adr/0004-modular-monolith.md).
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  // Native modules must be loaded from node_modules at runtime, never bundled.
  serverExternalPackages: ['better-sqlite3', '@node-rs/argon2'],
  // Migrations are read from disk at boot; make sure they ship with the standalone output.
  outputFileTracingIncludes: {
    '/**': ['./drizzle/**/*'],
  },
  outputFileTracingExcludes: {
    '/**': ['./src/**/*', './tests/**/*', './docs/**/*', './data/**/*'],
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
