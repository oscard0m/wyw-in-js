import { Entrypoint } from '../Entrypoint';
import type { Services } from '../types';

import { createServices } from './entrypoint-helpers';

/* eslint-disable import/no-unresolved -- Bun is the package test runtime. */
// @ts-expect-error The package test runtime provides bun:test; the legacy spec
// typings in this repo only know the jest globals.
const { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } =
  (await import('bun:test')) as {
    afterEach: (fn: () => void) => void;
    beforeEach: (fn: () => void) => void;
    describe: (name: string, fn: () => void) => void;
    expect: jest.Expect;
    it: (name: string, fn: () => void) => void;
    setSystemTime: (date?: Date) => void;
    spyOn: typeof jest.spyOn;
  };
/* eslint-enable import/no-unresolved */

const BASE_TIME = new Date('2026-01-01T00:00:00Z').getTime();

// Regression test for the supersede-storm OOM: when cache invalidation keeps
// reporting an entrypoint as changed (an oscillator), Entrypoint.create used
// to supersede it with a non-widening `only` on every request, unboundedly
// (observed at 10k+ generations for a single file). The guard caps the rate:
// past the limit, the cached entrypoint is reused instead of superseded, but
// only while the requested code is byte-identical to the cached one.
describe('supersede storm guard', () => {
  const name = '/storm.js';
  const only = ['__wywPreval'];
  const code = 'const a = 1;';

  let services: Services;
  let consoleErrorSpy: jest.SpyInstance;
  let invalidateSpy: jest.SpyInstance;

  beforeEach(() => {
    setSystemTime(new Date(BASE_TIME));
    services = createServices();
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    // The real storm is a false-positive invalidation: the bytes on disk
    // never change, but a dependency with an unknown graph reports "changed"
    // on every check. Forcing invalidateIfChanged to true reproduces exactly
    // that: identical content, `changed` path taken on every createRoot.
    invalidateSpy = spyOn(
      services.cache,
      'invalidateIfChanged'
    ).mockReturnValue(true);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    invalidateSpy.mockRestore();
    setSystemTime();
  });

  const createRootOnce = (loadedCode: string = code) =>
    Entrypoint.createRoot(services, name, only, loadedCode);

  it('stops superseding a non-widening entrypoint past the rate limit', () => {
    let last = createRootOnce();
    for (let i = 1; i < 150; i += 1) {
      last = createRootOnce();
    }

    // Unbounded before the guard: 150 requests -> generation 150.
    expect(last.generation).toBeLessThan(120);

    // Once the guard is active, the same instance is reused.
    const next = createRootOnce();
    expect(next).toBe(last);
    expect(next.supersededWith).toBeNull();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('supersede storm detected')
    );
  });

  it('keeps superseding when the code actually changed, but still logs', () => {
    // A guard that reuses the cached entrypoint despite changed bytes would
    // silently serve stale code to a legitimate rapid-rewrite loop (e.g. a
    // code generator). Alternating content must therefore never be reused.
    let last = createRootOnce('const a = 1;');
    for (let i = 1; i < 150; i += 1) {
      const next = createRootOnce(
        i % 2 === 0 ? 'const a = 1;' : 'const a = 2;'
      );
      expect(next).not.toBe(last);
      last = next;
    }

    expect(last.generation).toBe(150);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('supersede storm detected')
    );
  });

  it('allows superseding again after the entrypoint has been quiet for the window', () => {
    let last = createRootOnce();
    for (let i = 1; i < 150; i += 1) {
      last = createRootOnce();
    }
    const stormGeneration = last.generation;
    expect(createRootOnce()).toBe(last);

    setSystemTime(new Date(BASE_TIME + 11_000));

    const afterQuiet = createRootOnce();
    expect(afterQuiet).not.toBe(last);
    expect(afterQuiet.generation).toBe(stormGeneration + 1);
  });

  it('does not interfere with normal-paced rebuilds', () => {
    let last = createRootOnce();
    for (let i = 1; i < 150; i += 1) {
      setSystemTime(new Date(BASE_TIME + i * 11_000));
      last = createRootOnce();
    }

    expect(last.generation).toBe(150);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
