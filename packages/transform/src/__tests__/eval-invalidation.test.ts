import fs from 'fs';
import os from 'os';
import path from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';

const processorFile = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const resolveWithExtensions = (candidate: string) => {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs']) {
    const withExtension = `${candidate}${extension}`;
    if (fs.existsSync(withExtension) && fs.statSync(withExtension).isFile()) {
      return withExtension;
    }
  }

  return null;
};

describe.each([
  ['default hybrid', undefined],
  ['execute', 'execute' as const],
])('eval invalidation with %s strategy', (_label, strategy) => {
  it.each([
    ['leaf', 1],
    ['fan-out', 2],
  ])(
    'reloads an invalidated %s dependency with unchanged roots',
    async (_case, rootCount) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'wyw-eval-invalidate-')
      );
      const tokenFile = path.join(root, 'token.ts');
      const entryFiles = Array.from({ length: rootCount }, (_, index) =>
        path.join(root, `entry-${index}.ts`)
      );
      const cache = new TransformCacheCollection();

      const tagResolver = (source: string, tag: string) =>
        source === 'test-css-processor' && tag === 'css' ? processorFile : null;
      const asyncResolve = async (what: string, importer: string) => {
        if (what === 'test-css-processor') return processorFile;

        if (what.startsWith('.') || path.isAbsolute(what)) {
          const resolved = resolveWithExtensions(
            path.resolve(path.dirname(importer), what)
          );
          if (resolved) return resolved;
        }

        throw new Error(`Unable to resolve ${JSON.stringify(what)}`);
      };
      const runEntrypoint = (filename: string) =>
        transform(
          {
            cache,
            asyncResolveKey: 'eval-invalidation-test:v1',
            options: {
              filename,
              root,
              pluginOptions: {
                configFile: false,
                tagResolver,
                ...(strategy ? { eval: { strategy } } : {}),
                babelOptions: {
                  babelrc: false,
                  configFile: false,
                  presets: [
                    ['@babel/preset-env', { loose: true }],
                    '@babel/preset-react',
                    '@babel/preset-typescript',
                  ],
                },
              },
            },
          },
          fs.readFileSync(filename, 'utf8'),
          asyncResolve
        );
      const runAllEntrypoints = async () => {
        const results = [];
        for (let index = 0; index < entryFiles.length; index += 1) {
          // Fan-out order is intentionally deterministic; concurrency has its own
          // broker coverage and would add noise to this invalidation regression.
          // eslint-disable-next-line no-await-in-loop
          results.push(await runEntrypoint(entryFiles[index]));
        }

        return results;
      };

      try {
        fs.writeFileSync(
          tokenFile,
          dedent`
          export const color = (() => 'blue')();
        `
        );
        entryFiles.forEach((entryFile, index) => {
          fs.writeFileSync(
            entryFile,
            dedent`
            import { css } from 'test-css-processor';
            import { color } from './token';

            export const className${index} = css\`
              color: \${color};
            \`;
          `
          );
        });

        const rootSources = entryFiles.map((entryFile) =>
          fs.readFileSync(entryFile, 'utf8')
        );
        const initial = await runAllEntrypoints();
        initial.forEach((result) => expect(result.cssText).toContain('blue'));
        const warm = await runAllEntrypoints();
        warm.forEach((result, index) => {
          expect(result.cssText).toBe(initial[index].cssText);
        });

        fs.writeFileSync(
          tokenFile,
          dedent`
          export const color = (() => 'red')();
        `
        );
        cache.invalidateForFile(tokenFile);
        entryFiles.forEach((entryFile) => cache.invalidateForFile(entryFile));
        await runEntrypoint(tokenFile);

        const updated = await runAllEntrypoints();
        updated.forEach((result) => {
          expect(result.cssText).toContain('red');
          expect(result.cssText).not.toContain('blue');
        });
        entryFiles.forEach((entryFile, index) => {
          expect(fs.readFileSync(entryFile, 'utf8')).toBe(rootSources[index]);
        });
      } finally {
        disposeEvalBroker(cache);
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
