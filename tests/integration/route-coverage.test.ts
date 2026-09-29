import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const API_ROOT = path.join(process.cwd(), 'src/app/api');
const PUBLIC = new Set(['health GET', 'setup GET', 'setup POST', 'auth/login POST', 'auth/logout POST']);
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? routeFiles(p) : e.name === 'route.ts' ? [p] : [];
  });
}

describe('API route coverage', () => {
  it('every handler goes through defineRoute and only allowlisted handlers are public', async () => {
    const seen: string[] = [];
    for (const file of routeFiles(API_ROOT)) {
      const rel = path.relative(API_ROOT, path.dirname(file)).split(path.sep).join('/');
      const mod = (await import(file)) as Record<string, unknown>;
      for (const method of METHODS) {
        const handler = mod[method] as { __stackManagerRoute?: string } | undefined;
        if (!handler) continue;
        const key = `${rel} ${method}`;
        seen.push(key);
        expect(handler.__stackManagerRoute, `${key} must use defineRoute`).toBeDefined();
        expect(handler.__stackManagerRoute === 'public', `${key} public=${handler.__stackManagerRoute}`).toBe(
          PUBLIC.has(key),
        );
      }
    }
    expect(seen.length).toBeGreaterThan(15);
    for (const key of PUBLIC) expect(seen).toContain(key);
  });

  it('no container/image/network/volume management routes exist (product boundary)', () => {
    const all =
      routeFiles(path.join(process.cwd(), 'src/app')).join('\n') +
      fs.readdirSync(path.join(process.cwd(), 'src/app')).join('\n');
    expect(all).not.toMatch(/containers|images|networks|volumes/i);
  });
});
