import fs from 'node:fs';

import { TransformCacheCollection } from '../cache';
import type { IEntrypointDependency } from '../transform/Entrypoint.types';

// Mocking the minimal interface needed by the cache
type MockEntrypoint = {
  dependencies: Map<string, Pick<IEntrypointDependency, 'resolved'>>;
  generation: number;
  initialCode?: string;
  isProcessing?: boolean;
  invalidateOnDependencyChange?: Set<string>;
  invalidationDependencies?: Map<
    string,
    Pick<IEntrypointDependency, 'resolved'>
  >;
  name: string;
};

const mockedReadFileSync = jest.spyOn(fs, 'readFileSync');
const mockedStatSync = jest.spyOn(fs, 'statSync');

// Regression test for the supersede-storm OOM: a dependency whose entrypoint
// was evicted mid-processing has no dependency snapshot, so its graph is
// unknown. `didDependencyChange` used to answer "changed" for such a file on
// every check, which invalidated the parent on every root request; each
// invalidation superseded the parent entrypoint and re-armed the same check,
// looping (observed at 10k+ generations of one entrypoint) until the loader
// process ran out of memory. The unknown graph must be reported as changed
// exactly once; afterwards the dependency's own content hash decides.
describe('TransformCacheCollection: unknown-graph dependency oscillator', () => {
  const depName = 'dep.js';
  const depContent = 'export const token = "red";';
  const parentName = 'parent.js';
  const parentContent = 'import { token } from "./dep.js"; console.log(token);';

  let cache: TransformCacheCollection<MockEntrypoint>;
  let parentDependencies: MockEntrypoint['dependencies'];
  let depContentOnDisk: string;

  const reArmParent = (generation: number) => {
    cache.add('entrypoints', parentName, {
      name: parentName,
      initialCode: parentContent,
      dependencies: parentDependencies,
      invalidationDependencies: new Map(),
      generation,
    });
  };

  afterAll(() => {
    mockedReadFileSync.mockRestore();
    mockedStatSync.mockRestore();
  });

  beforeEach(() => {
    depContentOnDisk = depContent;
    mockedStatSync.mockReset();
    mockedStatSync.mockImplementation((path) => {
      if (path === depName) return { mtimeMs: 123 } as fs.Stats;
      throw new Error(`Unexpected statSync call: ${String(path)}`);
    });
    mockedReadFileSync.mockReset();
    mockedReadFileSync.mockImplementation((path) => {
      if (path === depName) return depContentOnDisk;
      throw new Error(`Unexpected readFileSync call: ${String(path)}`);
    });

    cache = new TransformCacheCollection<MockEntrypoint>();
    parentDependencies = new Map([['./dep.js', { resolved: depName }]]);
    reArmParent(1);

    // Record the dependency's fs content hash + mtime, then evict its
    // entrypoint while it is processing: no dependency snapshot is taken, so
    // the dependency ends up in the "unknown graph" state.
    cache.add('entrypoints', depName, {
      name: depName,
      initialCode: depContent,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 1,
      isProcessing: true,
    });
    cache.invalidateIfChanged(depName, depContent, undefined, 'fs');
    cache.delete('entrypoints', depName);
  });

  it('reports the unknown graph as changed exactly once while the content is unchanged', () => {
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);

    // Each invalidation evicts the parent, and the transform pipeline re-adds
    // a superseding entrypoint sharing the same dependencies map. Reproduce
    // that re-arming pattern: the check must stay converged instead of
    // reporting "changed" forever.
    for (let i = 0; i < 5; i += 1) {
      reArmParent(i + 2);
      expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(false);
    }
  });

  it('still catches a real content change after the one-time report', () => {
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);
    reArmParent(2);
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(false);

    depContentOnDisk = 'export const token = "blue";';
    reArmParent(3);
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);

    // The new hash is recorded, so the check converges again.
    reArmParent(4);
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(false);
  });

  it('reports the unknown graph again once the dependency graph was known in between', () => {
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);
    reArmParent(2);
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(false);

    // The dependency gets a live entrypoint again (its graph becomes known),
    // then is evicted mid-processing once more: back to unknown, which is
    // worth one more conservative report.
    cache.add('entrypoints', depName, {
      name: depName,
      initialCode: depContent,
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      generation: 2,
      isProcessing: true,
    });
    cache.delete('entrypoints', depName);

    reArmParent(3);
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);
    reArmParent(4);
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(false);
  });
});
