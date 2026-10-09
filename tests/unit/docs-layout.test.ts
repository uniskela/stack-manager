import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

/** Published URL slugs. Moving a file must not change these. */
const PUBLIC_SLUGS = [
  'readme',
  'index',
  'installation',
  'getting-started',
  'git-workflow',
  'self-hosting',
  'backup-restore',
  'auth-and-credentials',
  'security',
  'product',
  'stack-discovery',
  'architecture',
  'releasing',
  'testing',
  'plans/mvp-plan',
];

type Page = { source: string; slug: string; kind: string };

function markdownFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

function relativeLinks(file: string): string[] {
  const text = fs
    .readFileSync(file, 'utf8')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');
  return [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1] ?? '');
}

describe('docs audience split', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs/manifest.json'), 'utf8')) as {
    schemaVersion: number;
    pages: Page[];
  };

  it('publishes the same slugs from docs/public and README only', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.pages.map((page) => page.slug)).toEqual(PUBLIC_SLUGS);
    const publicDocs = markdownFiles(path.join(root, 'docs/public')).map((file) =>
      path.relative(root, file).split(path.sep).join('/'),
    );
    expect(manifest.pages.map((page) => page.source).sort()).toEqual(['README.md', ...publicDocs].sort());
    for (const page of manifest.pages) {
      expect(page.source.startsWith('docs/internal/') || page.source.startsWith('docs/agents/')).toBe(false);
      expect(fs.existsSync(path.join(root, page.source))).toBe(true);
    }
  });

  it('keeps the product boundary and root agent guide in place', () => {
    const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('](docs/public/PRODUCT.md)');
    expect(agents).toContain('](docs/internal/adr/0005-product-boundary.md)');
    expect(fs.existsSync(path.join(root, 'docs/internal/adr/0005-product-boundary.md'))).toBe(true);
    const notes = fs.readFileSync(path.join(root, 'docs/agents/README.md'), 'utf8');
    expect(notes).toContain('](../../AGENTS.md)');
    expect(notes).not.toContain('Portainer/Komodo/Arcane replacement');
  });

  it('resolves relative markdown links', () => {
    const files = [
      ...markdownFiles(path.join(root, 'docs')),
      path.join(root, 'README.md'),
      path.join(root, 'AGENTS.md'),
      path.join(root, '.github/docs-sync.md'),
    ];
    const missing: string[] = [];
    for (const file of files) {
      for (const link of relativeLinks(file)) {
        if (/^(https?:|mailto:)/.test(link) || link.startsWith('#')) continue;
        const target = decodeURIComponent(link.split('#')[0]?.split('?')[0] ?? '');
        if (!target) continue;
        const resolved = path.resolve(path.dirname(file), target);
        if (!resolved.startsWith(root + path.sep) && resolved !== root) {
          missing.push(`${path.relative(root, file)} -> ${link}`);
          continue;
        }
        if (!fs.existsSync(resolved)) missing.push(`${path.relative(root, file)} -> ${link}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
