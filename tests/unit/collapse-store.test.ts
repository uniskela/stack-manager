import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StoreModule = typeof import('@/ui/stacks/collapse-store');

function mockSessionStorage() {
  const store = new Map<string, string>();
  let failSet = false;
  const sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failSet) throw new DOMException('QuotaExceededError');
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: () => null,
  };
  vi.stubGlobal('sessionStorage', sessionStorage);
  return {
    store,
    failNextSet: () => {
      failSet = true;
    },
    allowSet: () => {
      failSet = false;
    },
  };
}

describe('collapse-store', () => {
  let storage: ReturnType<typeof mockSessionStorage>;
  let mod: StoreModule;

  beforeEach(async () => {
    vi.resetModules();
    storage = mockSessionStorage();
    mod = await import('@/ui/stacks/collapse-store');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('persists and reads a collapse map', () => {
    mod.writeCollapseMap('ws', { repo: true });
    expect(mod.readCollapseMap('ws')).toEqual({ repo: true });
    expect(storage.store.get('sm.stacks.collapse.ws')).toBe('{"repo":true}');
  });

  it('keeps a toggle after a failed write when an older map is already stored', () => {
    mod.writeCollapseMap('ws', { repo: true, 'repo:apps': false });
    expect(storage.store.get('sm.stacks.collapse.ws')).toContain('"repo":true');

    storage.failNextSet();
    mod.writeCollapseMap('ws', { repo: false, 'repo:apps': true });

    // Old value remains in sessionStorage; the in-memory snapshot must win.
    expect(storage.store.get('sm.stacks.collapse.ws')).toBe('{"repo":true,"repo:apps":false}');
    expect(mod.readCollapseMap('ws')).toEqual({ repo: false, 'repo:apps': true });
    expect(mod.isCollapsed(mod.readCollapseMap('ws'), 'repo:apps')).toBe(true);
  });

  it('clears the dirty snapshot once a later write succeeds', () => {
    mod.writeCollapseMap('ws', { repo: true });
    storage.failNextSet();
    mod.writeCollapseMap('ws', { repo: false });
    expect(mod.readCollapseMap('ws')).toEqual({ repo: false });

    storage.allowSet();
    mod.writeCollapseMap('ws', { repo: false, folder: true });
    expect(storage.store.get('sm.stacks.collapse.ws')).toBe('{"repo":false,"folder":true}');
    expect(mod.readCollapseMap('ws')).toEqual({ repo: false, folder: true });
  });
});
