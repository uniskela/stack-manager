import { describe, expect, it, vi } from 'vitest';
import { ChangelogReader } from '@/server/providers/changelog/reader';
import type { readHttps } from '@/server/security/https-read';

const source = 'https://example.com/CHANGELOG.md';

function fixture(text: string, status = 200) {
  const read = vi.fn<typeof readHttps>().mockResolvedValue({ status, body: Buffer.from(text) });
  return { read, reader: new ChangelogReader({ read }) };
}

describe('ChangelogReader', () => {
  it.each([
    'javascript:alert(1)',
    'http://example.com/notes',
    'https://user:secret@example.com/notes',
    'https://@example.com/notes',
    'https://example.com\\@internal.example/notes',
    'https://LOCALHOST./notes',
    'https://0x7f000001/notes',
    'https://[::ffff:7f00:1]/notes',
    'https://192.168.11.22/notes',
  ])('skips requests to unsupported URLs (%s)', async (url) => {
    const { read, reader } = fixture('');
    await expect(reader.check(url, '1.0.0', '2.0.0')).resolves.toMatchObject({
      status: 'unavailable',
      url: '',
      signals: [],
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('discards query credentials and fetches through the bounded public HTTPS path', async () => {
    const { read, reader } = fixture('## 2.0.0\n- Upgrade the database schema.');
    const result = await reader.check(
      'https://EXAMPLE.com:443/CHANGELOG.md?unknown=secret#release-200',
      '1.0.0',
      '2.0.0',
    );

    expect(result.url).toBe(source + '#release-200');
    const [url, options] = read.mock.calls[0]!;
    expect(url.href).toBe(source);
    expect(options.allowPrivateNetworks).toBe(false);
    expect(Object.keys(options.headers).every((key) => key.toLowerCase() === 'accept')).toBe(true);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.maxBytes).toBeGreaterThan(0);
    expect(options.maxBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('extracts signals in the selected release range, prioritizing the target', async () => {
    const { reader } = fixture(`# Changelog
## [3.0.0](https://example.com/compare/v2.0.0...v3.0.0) - 2026-11-23
- Breaking change for a future version.
## [2.0.0](https://example.com/compare/v1.5.0...v2.0.0) - 2026-11-20
### Changes
- Breaking change: remove the legacy configuration.
## Version 1.5.0 (2026-10-10)
- Manual migration required for old state.
## Release v1.0.0
- Upgrade warning for the installed version.
## v0.9.0
- Deprecated the earlier system.
`);

    const result = await reader.check(source, '1.0.0', 'v2.0.0');
    expect(result.status).toBe('checked');
    expect(result.signals).toEqual([
      'Breaking change: remove the legacy configuration.',
      'Manual migration required for old state.',
    ]);
  });

  it('does not treat longer version strings or version mentions as the installed boundary', async () => {
    const { reader } = fixture(`# Changelog
## 2.0.0
- Upgrade the database from 1.0.0 if needed.
## 1.0.00
- Unrelated release.
## Changes since 1.0.0
- Unrelated section.
## 1.0.0 - 1.1.0
- Version comparison.
`);
    const result = await reader.check(source, '1.0.0', '2.0.0');
    expect(result.status).toBe('incomplete');
    expect(result.signals).toEqual(['Upgrade the database from 1.0.0 if needed.']);
  });

  it('ignores fenced examples and avoids matching a stable tag to a prerelease heading', async () => {
    const { reader } = fixture(`# Changelog
## 2.0.0-rc.1
- Migration warnings for the prerelease.
\`\`\`markdown
## 2.0.0
- Breaking change in a code example.
\`\`\`
## 1.0.0
- Earlier release.
`);
    const result = await reader.check(source, '1.0.0', '2.0.0');
    expect(result.status).toBe('incomplete');
    expect(result.signals).not.toContain('Breaking change in a code example.');
  });

  it('reads ordinary HTML headings and returns plain text from release notes', async () => {
    const { reader } = fixture(`<html><body>
<h2>Release v2.0.0</h2>
<script>Breaking change: hidden script</script>
<p>Upgrade using <a href="https://user:secret@example.com/procedure?secret=abc">the guide</a> &amp; restart.</p>
<h2>Release v1.0.0</h2>
<p>Initial release.</p>
</body></html>`);
    await expect(reader.check(source, '1.0.0', '2.0.0')).resolves.toMatchObject({
      status: 'checked',
      signals: ['Upgrade using the guide & restart.'],
    });
  });

  it('drops scripts in Markdown and removes destinations from visible URL excerpts', async () => {
    const { reader } = fixture(`# Changelog
## 2.0.0
<script>Upgrade by running a hidden script.</script>
- Upgrade using //name:example-secret@example.com/guide?key=another-secret
## 1.0.0
- Earlier release.
`);
    await expect(reader.check(source, '1.0.0', '2.0.0')).resolves.toMatchObject({
      status: 'checked',
      signals: ['Upgrade using'],
    });
  });

  it('keeps visible text from nested Markdown formatting and links', async () => {
    const { reader } = fixture(`# Changelog
## *[2.0.0][release]*
- **Upgrade** using [the (new) guide](https://example.com/docs_(new)) &copy; Example.
## 1.0.0
- Initial release.

[release]: https://example.com/releases/2.0.0
`);
    await expect(reader.check(source, '1.0.0', '2.0.0')).resolves.toMatchObject({
      status: 'checked',
      signals: ['Upgrade using the (new) guide © Example.'],
    });
  });

  it('extracts HTML text across inline elements and block boundaries', async () => {
    const { reader } = fixture(`<!doctype html><html><head><title>Release notes</title></head><body><main>
<h2 data-label="Release > details"><em>2.0.0</em></h2>
<p>Upgrade <strong>the database</strong>.<br>Manual intervention may be needed.</p>
<pre>Breaking change in an example.</pre>
<h2>1.0.0</h2><p>Initial release.</p>
</main></body></html>`);
    await expect(reader.check(source, '1.0.0', '2.0.0')).resolves.toMatchObject({
      status: 'checked',
      signals: ['Upgrade the database.', 'Manual intervention may be needed.'],
    });
  });

  it('keeps prerelease and build identifiers distinct in version boundaries', async () => {
    const { reader } = fixture(`## Release v2.0.0-rc.1+build.3: 2026-11-23
- Upgrade the database.
## [1.0.0-rc.2+build.5]
- Initial release.
`);
    await expect(reader.check(source, '1.0.0-rc.2+build.5', '2.0.0-rc.1+build.3')).resolves.toMatchObject({
      status: 'checked',
      signals: ['Upgrade the database.'],
    });
  });

  it('does not form a release range across separate version lists', async () => {
    const { reader } = fixture(`# Application releases
## 2.0.0
- Upgrade the application.
# Example dependency releases
## 1.0.0
- Initial release of the dependency.
`);
    await expect(reader.check(source, '1.0.0', '2.0.0')).resolves.toMatchObject({
      status: 'incomplete',
      signals: ['Upgrade the application.'],
    });
  });

  it('does not use a quoted version heading as a release boundary', async () => {
    const { reader } = fixture(`## 2.0.0
- Upgrade the application.

> ## 1.0.0
> Example release.
`);
    await expect(reader.check(source, '1.0.0', '2.0.0')).resolves.toMatchObject({
      status: 'incomplete',
      signals: ['Upgrade the application.'],
    });
  });

  it('identifies a release range in an oldest-first changelog', async () => {
    const { reader } = fixture(`1.0.0
-----
First release.
1.5.0
-----
Manual migration of the database.
2.0.0
-----
Breaking change: remove the legacy configuration.
`);
    await expect(reader.check(source, '1.0.0', '2.0.0')).resolves.toMatchObject({
      status: 'checked',
      signals: ['Breaking change: remove the legacy configuration.', 'Manual migration of the database.'],
    });
  });

  it('does not present notes for an unrelated release when only the installed version matches', async () => {
    const { reader } = fixture('## 3.0.0\n- Migration required.\n## 1.0.0\n- Initial release.');
    await expect(reader.check(source, '1.0.0', '2.0.0')).resolves.toMatchObject({
      status: 'incomplete',
      signals: [],
    });
  });

  it.each([
    '',
    '## 2.0.0\n## 1.0.0',
    '<html><script>Upgrade now</script></html>',
    '<html><h1>Sign in</h1><p>Access denied</p></html>',
  ])('reports unavailable when there are no recognizable release notes', async (body) => {
    const { reader } = fixture(body);
    await expect(reader.check(source, '1.0.0', '2.0.0')).resolves.toMatchObject({
      status: 'unavailable',
      signals: [],
    });
  });

  it('does not trust a redirect response body', async () => {
    const { reader } = fixture('## 2.0.0\n- Breaking change.', 302);
    await expect(reader.check(source, '1.0.0', '2.0.0')).resolves.toMatchObject({
      status: 'unavailable',
      signals: [],
    });
  });

  it('does not surface raw transport errors', async () => {
    const { read, reader } = fixture('');
    read.mockRejectedValue(new Error('secret detail'));
    const result = await reader.check(source, '1.0.0', '2.0.0');
    expect(result.status).toBe('unavailable');
    expect(result.url).toBe(source);
    expect(result.detail).not.toContain('secret detail');
  });
});
