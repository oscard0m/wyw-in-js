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
  export const space = { s4: 4 };
  export const themeVars = { sep: 'var(--sep)' };
  export const textClasses = { regular: 'regular' };
`;

const runStatic = async (source: string) => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-member-const-'));
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
  import { space, textClasses, themeVars } from './tokens';
`;

const TEMPLATE_CONST = 'const helper = `0 1px 0 0 ${themeVars.sep}`;';
const OBJECT_CONST = 'const helper = {boxShadow: `x ${themeVars.sep}`};';
const MEMBER_CONST = 'const helper = themeVars.sep;';
const LITERAL_CONST = "const helper = '0 1px';";
const CX_CALL = 'export const g = cx(css`z-index: 800;`, textClasses.regular);';
const INTERPOLATED = 'export const a = css`padding: ${space.s4}px;`;';

const source = (...parts: string[]) => [HEADER, '', ...parts].join('\n');

/**
 * A module-level const that merely *reads* an imported member makes a later
 * interpolation unresolvable once any `cx()` call sits between them.
 *
 * The const is not referenced by either tag and is never mutated; reading
 * `themeVars.sep` into a local is enough. Replacing the initialiser with a
 * literal, dropping the `cx()` call, or declaring the interpolated tag before
 * the call all resolve, so the three ingredients are jointly required.
 */
describe('static eval with a module-level imported-member const', () => {
  const expectResolved = (cssText: string) => {
    expect(cssText).toContain('padding:4px');
  };

  it('resolves with a template-literal const before the cx() call', async () => {
    const result = await runStatic(
      source(TEMPLATE_CONST, CX_CALL, INTERPOLATED)
    );
    expectResolved(result.cssText);
  });

  it('resolves with an object const before the cx() call', async () => {
    const result = await runStatic(source(OBJECT_CONST, CX_CALL, INTERPOLATED));
    expectResolved(result.cssText);
  });

  it('resolves with a bare member const before the cx() call', async () => {
    const result = await runStatic(source(MEMBER_CONST, CX_CALL, INTERPOLATED));
    expectResolved(result.cssText);
  });

  // Controls: each drops one of the three ingredients and passes today.

  it('resolves without the const', async () => {
    const result = await runStatic(source(CX_CALL, INTERPOLATED));
    expectResolved(result.cssText);
  });

  it('resolves without the cx() call', async () => {
    const result = await runStatic(source(TEMPLATE_CONST, INTERPOLATED));
    expectResolved(result.cssText);
  });

  it('resolves when the const initialiser is a literal', async () => {
    const result = await runStatic(
      source(LITERAL_CONST, CX_CALL, INTERPOLATED)
    );
    expectResolved(result.cssText);
  });

  it('resolves when the interpolated tag precedes the cx() call', async () => {
    const result = await runStatic(
      source(TEMPLATE_CONST, INTERPOLATED, CX_CALL)
    );
    expectResolved(result.cssText);
  });
});
