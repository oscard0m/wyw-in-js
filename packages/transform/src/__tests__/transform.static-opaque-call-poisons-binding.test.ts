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

const runStatic = async (
  source: string,
  modules: Record<string, string> = {}
) => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-opaque-call-'));
  const entryFile = join(root, 'entry.tsx');
  writeFileSync(entryFile, source);
  Object.entries(modules).forEach(([name, code]) => {
    writeFileSync(join(root, name), code);
  });

  try {
    return await transform(
      {
        cache: new TransformCacheCollection(),
        options: {
          filename: entryFile,
          root,
          pluginOptions: {
            configFile: false,
            eval: { require: 'off', strategy: 'static', resolver: 'native' },
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

const HEADER = "import { css } from 'test-css-processor';";

const OBJECT = 'const space = {s12: 12, s16: 16};';
const SCALAR = 'const s12 = 12;';

const CALL_WHOLE = 'export const opaque = String(space);';
const CALL_MEMBER = 'export const opaque = String(space.s12);';
const CALL_OTHER_MEMBER = 'export const opaque = String(space.s16);';
const CALL_OBJECT_KEYS = 'export const opaque = Object.keys(space);';
const CALL_OBJECT_FROM_ENTRIES =
  'export const opaque = Object.fromEntries(Object.entries(space).map(([k, v]) => [v, k]));';
const CALL_ARRAY_METHOD = dedent`
  const scale = [space.s12, space.s16];
  export const opaque = scale.map((value) => value);
`;
const CALL_VIA_LOCAL = dedent`
  const wrap = (x: unknown) => String(x);
  export const opaque = wrap(space);
`;
const CALL_SCALAR = 'export const opaque = String(s12);';
const CALL_UNRELATED = 'export const opaque = String(1);';
const CALL_STATIC_LOCAL = dedent`
  const f = (x: number) => x;
  export const opaque = f(space.s12);
`;
const CALL_IN_FUNCTION = 'export const C = () => String(space);';
// What a bundler emits for `<Icon size={space.s12} />`. Authored JSX only
// reaches this state after transpilation, which is why a story file can fail
// the real build while its untranspiled source transforms cleanly.
const CALL_TRANSPILED_JSX = dedent`
  const jsx = (type: unknown, props: unknown) => ({props, type});
  export const opaque = jsx('div', {size: space.s12});
`;

const TAG = 'export const a = css`padding: ${space.s12}px;`;';
const TAG_SCALAR = 'export const a = css`padding: ${s12}px;`;';
const TAG_LITERAL = 'export const a = css`padding: 12px;`;';

const source = (...parts: string[]) => [HEADER, '', ...parts].join('\n');

/**
 * A module-level call the static evaluator cannot fold poisons the *whole*
 * binding it consumes, so a later tag interpolating any member of that binding
 * becomes an unresolvable `_exp`.
 *
 * Three ingredients are jointly required: an object binding, a tag reading one
 * of its members, and an eagerly-evaluated opaque call at module scope that
 * also consumes it. A scalar binding, a call the evaluator can fold, or moving
 * the call into a function body all resolve.
 *
 * Poisoning is per-binding, not per-property: `String(space.s16)` breaks a tag
 * that only reads `space.s12`.
 *
 * Reduced from a design system's toast module, where a `defaultPropsPerType`
 * record built JSX icons at module scope. JSX is not special -- it is merely a
 * common way to get an opaque module-level call, and it reaches this state only
 * once transpiled to `jsx(...)`, so the cases here call `String`/`Object.keys`
 * directly. That file's seven interpolations, including trivial ones like
 * `gap: ${space.s12}px`, all failed that package's Vite build with
 * `eval.strategy: "static" cannot fall back`.
 */
describe('static eval with an opaque module-level call consuming the binding', () => {
  const expectResolved = (cssText: string) => {
    expect(cssText).toContain('padding:12px');
  };

  it('resolves when the call takes the whole object', async () => {
    const result = await runStatic(source(OBJECT, CALL_WHOLE, TAG));
    expectResolved(result.cssText);
  });

  it('resolves when the call takes the same member the tag reads', async () => {
    const result = await runStatic(source(OBJECT, CALL_MEMBER, TAG));
    expectResolved(result.cssText);
  });

  it('resolves when the call takes a different member than the tag', async () => {
    const result = await runStatic(source(OBJECT, CALL_OTHER_MEMBER, TAG));
    expectResolved(result.cssText);
  });

  it('resolves with Object.keys as the opaque call', async () => {
    const result = await runStatic(source(OBJECT, CALL_OBJECT_KEYS, TAG));
    expectResolved(result.cssText);
  });

  it('resolves with Object.fromEntries as the opaque call', async () => {
    const result = await runStatic(
      source(OBJECT, CALL_OBJECT_FROM_ENTRIES, TAG)
    );
    expectResolved(result.cssText);
  });

  // A method call on a derived array reaches the same state as a bare
  // `String(...)`, so the defect is not tied to the global built-ins above.
  it('resolves with an array method as the opaque call', async () => {
    const result = await runStatic(source(OBJECT, CALL_ARRAY_METHOD, TAG));
    expectResolved(result.cssText);
  });

  it('resolves with a transpiled JSX factory call', async () => {
    const result = await runStatic(source(OBJECT, CALL_TRANSPILED_JSX, TAG));
    expectResolved(result.cssText);
  });

  it('resolves when the opaque call is wrapped in a local function', async () => {
    const result = await runStatic(source(OBJECT, CALL_VIA_LOCAL, TAG));
    expectResolved(result.cssText);
  });

  // Controls: each drops or moves one ingredient and passes today.

  it('resolves with a scalar binding', async () => {
    const result = await runStatic(source(SCALAR, CALL_SCALAR, TAG_SCALAR));
    expectResolved(result.cssText);
  });

  it('resolves when the call does not consume the binding', async () => {
    const result = await runStatic(source(OBJECT, CALL_UNRELATED, TAG));
    expectResolved(result.cssText);
  });

  it('resolves when the call is statically foldable', async () => {
    const result = await runStatic(source(OBJECT, CALL_STATIC_LOCAL, TAG));
    expectResolved(result.cssText);
  });

  it('resolves when the call sits inside a function body', async () => {
    const result = await runStatic(source(OBJECT, CALL_IN_FUNCTION, TAG));
    expectResolved(result.cssText);
  });

  it('resolves without the opaque call', async () => {
    const result = await runStatic(source(OBJECT, TAG));
    expectResolved(result.cssText);
  });

  it('resolves when the tag has no interpolation', async () => {
    const result = await runStatic(source(OBJECT, CALL_WHOLE, TAG_LITERAL));
    expectResolved(result.cssText);
  });

  it.each(['#__PURE__', '@__PURE__'])(
    'trusts a %s annotation on an imported opaque call',
    async (annotation) => {
      const result = await runStatic(
        dedent`
        ${HEADER}
        import { opaque } from './runtime';
        import { space } from './tokens';

        /*${annotation}*/ opaque(space);
        ${TAG}
      `,
        {
          'runtime.ts':
            'export const opaque = (value: unknown) => String(value);',
          'tokens.ts': OBJECT.replace('const ', 'export const '),
        }
      );

      expectResolved(result.cssText);
    }
  );

  it('trusts a PURE annotation on an imported opaque constructor', async () => {
    const result = await runStatic(
      dedent`
        ${HEADER}
        import { Opaque } from './runtime';
        import { space } from './tokens';

        /*#__PURE__*/ new Opaque(space);
        ${TAG}
      `,
      {
        'runtime.ts': dedent`
          export class Opaque {
            constructor(value: unknown) {
              String(value);
            }
          }
        `,
        'tokens.ts': OBJECT.replace('const ', 'export const '),
      }
    );

    expectResolved(result.cssText);
  });

  it('trusts a PURE annotation on the outer invocation in a call chain', async () => {
    const result = await runStatic(
      dedent`
        ${HEADER}
        import { factory } from './runtime';
        import { space } from './tokens';

        /*#__PURE__*/ factory()(space);
        ${TAG}
      `,
      {
        'runtime.ts': dedent`
          export const factory = () => (value: unknown) => String(value);
        `,
        'tokens.ts': OBJECT.replace('const ', 'export const '),
      }
    );

    expectResolved(result.cssText);
  });

  it('keeps the result of an annotated opaque call non-static', async () => {
    try {
      await runStatic(
        dedent`
          ${HEADER}
          import { opaque } from './runtime';
          import { space } from './tokens';

          const runtimeValue = /*#__PURE__*/ opaque(space);
          export const a = css\`padding: ${'${runtimeValue}'}px;\`;
        `,
        {
          'runtime.ts':
            'export const opaque = (value: unknown) => String(value);',
          'tokens.ts': OBJECT.replace('const ', 'export const '),
        }
      );
      throw new Error('expected static strategy to fail');
    } catch (error) {
      const { message } = error as Error;
      expect(message).toContain('eval.strategy: "static"');
      expect(message).not.toContain('Calls that may be safe to annotate');
    }
  });

  it('does not hide a nested opaque call in an annotated argument', async () => {
    await expect(
      runStatic(
        dedent`
          ${HEADER}
          import { mutate, opaque } from './runtime';
          import { space } from './tokens';

          /*#__PURE__*/ opaque(mutate(space));
          ${TAG}
        `,
        {
          'runtime.ts': dedent`
            export const mutate = (value: unknown) => value;
            export const opaque = (value: unknown) => String(value);
          `,
          'tokens.ts': OBJECT.replace('const ', 'export const '),
        }
      )
    ).rejects.toThrow('an earlier call may mutate an imported value');
  });
});
