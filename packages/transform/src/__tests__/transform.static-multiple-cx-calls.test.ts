import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import type { PluginOptions } from '../types';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

const createResolver = () => async (what: string, importer: string) => {
  if (what === 'test-css-processor') {
    return processorFile;
  }
  if (what.startsWith('.')) {
    const base = resolve(dirname(importer), what);
    for (const ext of ['', '.ts', '.tsx', '.js']) {
      if (existsSync(base + ext)) {
        return base + ext;
      }
    }
    return base;
  }
  return null;
};

const TOKENS = dedent`
  export const space = { s6: 6, s10: 10 };
  export const fontWeight = { medium: 500 };
  export const themeVars = { fg: 'var(--fg)' };
  export const textClasses = { regular: 'regular', small: 'small' };
`;

const runStatic = async (source: string) => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-multi-cx-'));
  const entryFile = join(root, 'entry.ts');
  writeFileSync(join(root, 'tokens.ts'), TOKENS);
  writeFileSync(entryFile, source);

  try {
    return await transform(
      {
        cache: new TransformCacheCollection(),
        options: {
          filename: entryFile,
          root,
          pluginOptions: {
            configFile: false,
            eval: { require: 'off', strategy: 'static' },
            tagResolver: (tagSource: string, tag: string) =>
              tagSource === 'test-css-processor' && tag === 'css'
                ? processorFile
                : null,
          } as Partial<PluginOptions> as PluginOptions,
        },
      },
      readFileSync(entryFile, 'utf8'),
      createResolver()
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const HEADER = dedent`
  import { css, cx } from 'test-css-processor';
  import { fontWeight, space, textClasses, themeVars } from './tokens';
`;

const CX_FIRST =
  'const t1 = cx(textClasses.regular, css`font-weight: ${fontWeight.medium};`);';
const CX_SECOND =
  'const t2 = cx(textClasses.small, css`color: ${themeVars.fg};`);';
const CX_THIRD = 'const t3 = cx(textClasses.regular, css`z-index: 1;`);';
const CX_NO_IMPORTED_ARG = [
  'const t1 = cx(css`font-weight: 500;`);',
  'const t2 = cx(css`color: red;`);',
].join('\n');
const INTERPOLATED =
  'export const c = css`gap: ${space.s6}px; padding: ${space.s10}px;`;';

const source = (...parts: string[]) => [HEADER, '', ...parts].join('\n');

/**
 * A second `cx(importedMember, css``)` at module scope re-poisons the static
 * candidates that the first one leaves resolvable.
 *
 * One such call is handled: the imported member resolves to a string, so the
 * capability-bounded guard discharges the hazard. Adding a second identical
 * call makes every interpolation declared after it unresolvable again, so the
 * count of failures tracks the tags that follow rather than the calls
 * themselves.
 */
describe('static eval after multiple module-level cx() calls', () => {
  const expectResolved = (cssText: string) => {
    expect(cssText).toContain('gap:6px');
    expect(cssText).toContain('padding:10px');
  };

  it('resolves after a single cx()', async () => {
    const result = await runStatic(source(CX_FIRST, INTERPOLATED));
    expectResolved(result.cssText);
  });

  it('resolves after two cx() calls', async () => {
    const result = await runStatic(source(CX_FIRST, CX_SECOND, INTERPOLATED));
    expectResolved(result.cssText);
  });

  it('resolves after three cx() calls', async () => {
    const result = await runStatic(
      source(CX_FIRST, CX_SECOND, CX_THIRD, INTERPOLATED)
    );
    expectResolved(result.cssText);
  });

  // Controls: these pass today and bound the defect.

  it('resolves when the interpolated tag precedes both cx() calls', async () => {
    const result = await runStatic(source(INTERPOLATED, CX_FIRST, CX_SECOND));
    expectResolved(result.cssText);
  });

  it('resolves after two cx() calls that take no imported member', async () => {
    const result = await runStatic(source(CX_NO_IMPORTED_ARG, INTERPOLATED));
    expectResolved(result.cssText);
  });
});
