import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { TransformCacheCollection } from '../cache';
import {
  registerEvalTelemetryReporter,
  type EvalTelemetryRecord,
} from '../debug/evalTelemetry';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';
import type {
  IWorkflowAction,
  SyncScenarioForAction,
} from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

// eslint-disable-next-line require-yield
const workflow = function* workflow(): SyncScenarioForAction<IWorkflowAction> {
  return {
    code: 'module.exports = 1;',
    sourceMap: null,
  };
};

describe('transform asyncResolveKey', () => {
  it('reuses a scoped runner while resolver semantic keys stay isolated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-transform-resolver-scope-'));
    const entry = join(root, 'entry.ts');
    const serverTheme = join(root, 'server-theme.ts');
    const clientTheme = join(root, 'client-theme.ts');
    const source = [
      "import { css } from 'test-css-processor';",
      "import { color } from 'theme';",
      'export const className = css`color: ${color};`;',
    ].join('\n');
    writeFileSync(entry, source);
    writeFileSync(serverTheme, "export const color = 'server';");
    writeFileSync(clientTheme, "export const color = 'client';");

    const evalBrokerScope = {};
    const emitter = new EventEmitter(
      () => {},
      () => 0,
      () => {}
    );
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const run = (asyncResolveKey: string, themeFile: string) =>
      transform(
        {
          asyncResolveKey,
          cache: new TransformCacheCollection(),
          evalBrokerScope,
          eventEmitter: emitter,
          options: {
            filename: entry,
            root,
            pluginOptions: {
              configFile: false,
              eval: { strategy: 'execute' },
              tagResolver: (sourceName, tag) =>
                sourceName === 'test-css-processor' && tag === 'css'
                  ? processorFile
                  : null,
            },
          },
        },
        source,
        async (what: string) => {
          if (what === 'test-css-processor') return processorFile;
          if (what === 'theme') return themeFile;
          return null;
        }
      );

    try {
      const [server, client] = await Promise.all([
        run('server-resolver', serverTheme),
        run('client-resolver', clientTheme),
      ]);

      expect(server.cssText).toContain('server');
      expect(client.cssText).toContain('client');
      expect(
        records.filter(
          (record) =>
            record.type === 'eval-lifecycle' &&
            record.event === 'runner-spawn-attempt'
        )
      ).toHaveLength(1);
    } finally {
      unregister();
      disposeEvalBroker(evalBrokerScope);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('keeps eval cache key stable when asyncResolveKey stays the same', async () => {
    const cache = new TransformCacheCollection();
    const cachedEntrypoint = {
      dependencies: new Map<string, { resolved: string | null }>(),
    };
    const asyncResolveA = async () => null;
    const asyncResolveB = async () => null;

    await transform(
      {
        asyncResolveKey: 'webpack:compiler-a',
        cache,
        options: {
          filename: '/abs/entry-a.tsx',
          root: '/abs',
          pluginOptions: {
            configFile: false,
          },
        },
      },
      'export default 1;',
      asyncResolveA,
      { workflow }
    );

    cache.add('entrypoints', '/abs/shared.ts', cachedEntrypoint);

    await transform(
      {
        asyncResolveKey: 'webpack:compiler-a',
        cache,
        options: {
          filename: '/abs/entry-b.tsx',
          root: '/abs',
          pluginOptions: {
            configFile: false,
          },
        },
      },
      'export default 1;',
      asyncResolveB,
      { workflow }
    );

    expect(cache.get('entrypoints', '/abs/shared.ts')).toBe(cachedEntrypoint);
  });

  it('separates eval cache key when asyncResolveKey changes', async () => {
    const cache = new TransformCacheCollection();
    const cachedEntrypoint = {
      dependencies: new Map<string, { resolved: string | null }>(),
    };

    await transform(
      {
        asyncResolveKey: 'webpack:compiler-a',
        cache,
        options: {
          filename: '/abs/entry-a.tsx',
          root: '/abs',
          pluginOptions: {
            configFile: false,
          },
        },
      },
      'export default 1;',
      async () => null,
      { workflow }
    );

    cache.add('entrypoints', '/abs/shared.ts', cachedEntrypoint);

    await transform(
      {
        asyncResolveKey: 'webpack:compiler-b',
        cache,
        options: {
          filename: '/abs/entry-b.tsx',
          root: '/abs',
          pluginOptions: {
            configFile: false,
          },
        },
      },
      'export default 1;',
      async () => null,
      { workflow }
    );

    expect(cache.get('entrypoints', '/abs/shared.ts')).toBeUndefined();
  });
});
