import { describe, expect, it } from 'vitest';
import { docOrder, resolveRequested } from '@/app/_lib/source';

describe('docOrder', () => {
  it('puts the root README first, then root pages, then folders in path order with their README first', () => {
    const paths = [
      'angular/angular/README.md',
      'docs/setup.md',
      'CONTRIBUTING.md',
      'angular/notes.md',
      'README.md',
      'angular/README.md',
      'docs/README.md',
    ];
    expect([...paths].sort(docOrder(''))).toEqual([
      'README.md',
      'CONTRIBUTING.md',
      'angular/README.md',
      'angular/notes.md',
      'angular/angular/README.md',
      'docs/README.md',
      'docs/setup.md',
    ]);
  });

  it('orders relative to a stack folder', () => {
    const paths = ['apps/x/docs/b.md', 'apps/x/a.md', 'apps/x/README.md'];
    expect([...paths].sort(docOrder('apps/x'))).toEqual([
      'apps/x/README.md',
      'apps/x/a.md',
      'apps/x/docs/b.md',
    ]);
  });
});

describe('resolveRequested', () => {
  const allowed = (p: string) => ['apps/x/a.md', 'README.md'].includes(p);
  it('resolves paths relative to the root and rejects escapes, unknown and malformed values', () => {
    expect(resolveRequested('apps/x', 'a.md', allowed)).toBe('apps/x/a.md');
    expect(resolveRequested('', 'README.md', allowed)).toBe('README.md');
    expect(resolveRequested('apps/x', '../../README.md', allowed)).toBeNull();
    expect(resolveRequested('apps/x', 'missing.md', allowed)).toBeNull();
    expect(resolveRequested('', ['README.md'], allowed)).toBeNull();
    expect(resolveRequested('', undefined, allowed)).toBeNull();
  });
});
