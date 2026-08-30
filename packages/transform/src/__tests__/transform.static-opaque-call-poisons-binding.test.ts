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

const CALL_WHOLE = 'export const value = String(space);';
const CALL_IMPORTED_WHOLE = 'opaque(space);';
const CALL_MEMBER = 'opaque(space.s12);';
const CALL_OTHER_MEMBER = 'opaque(space.s16);';
const CALL_OBJECT = 'opaque({ size: space.s12 });';
const CALL_ARRAY = 'opaque([space.s12, space.s16]);';
const CALL_NESTED_OBJECT = 'opaque({ space });';
const CALL_OBJECT_WITH_PRIMITIVE = (value: string) =>
  `opaque({ size: space.s12, extra: ${value} });`;
const CALL_OBJECT_KEYS = 'export const value = Object.keys(space);';
const CALL_OBJECT_FROM_ENTRIES =
  'export const value = Object.fromEntries(Object.entries(space).map(([k, v]) => [v, k]));';
const CALL_ARRAY_METHOD = dedent`
  const scale = [space.s12, space.s16];
  export const value = scale.map((item) => item);
`;
const CALL_VIA_LOCAL = dedent`
  const wrap = (x: unknown) => String(x);
  export const value = wrap(space);
`;
const CALL_SCALAR = 'export const value = String(s12);';
const CALL_UNRELATED = 'export const value = String(1);';
const CALL_STATIC_LOCAL = dedent`
  const f = (x: number) => x;
  export const value = f(space.s12);
`;
const CALL_IN_FUNCTION = 'export const C = () => String(space);';
// What a bundler emits for `<Icon size={space.s12} />`. Authored JSX only
// reaches this state after transpilation, which is why a story file can fail
// the real build while its untranspiled source transforms cleanly.
const CALL_TRANSPILED_JSX = dedent`
  const jsx = (type: unknown, props: unknown) => ({props, type});
  export const value = jsx('div', {size: space.s12});
`;

const TAG = 'export const a = css`padding: ${space.s12}px;`;';
const TAG_SCALAR = 'export const a = css`padding: ${s12}px;`;';
const TAG_LITERAL = 'export const a = css`padding: 12px;`;';

const source = (...parts: string[]) => [HEADER, '', ...parts].join('\n');
const importedSource = (...parts: string[]) =>
  [
    HEADER,
    "import { opaque } from './runtime';",
    "import { space } from './tokens';",
    '',
    ...parts,
  ].join('\n');
const localSource = (...parts: string[]) =>
  [HEADER, "import { opaque } from './runtime';", '', ...parts].join('\n');
const importedModules = {
  'runtime.ts': 'export const opaque = (...values: unknown[]) => values;',
  'tokens.ts': OBJECT.replace('const ', 'export const '),
};
const localModules = {
  'runtime.ts': importedModules['runtime.ts'],
};

/**
 * Before this fix, a module-level call the static evaluator could not fold
 * poisoned the whole imported binding even when the call only received an
 * immutable primitive copied out of it.
 *
 * The mutation guard now proves primitive leaves (including leaves copied into
 * a fresh object or array) at resolution time. Passing the mutable object
 * itself remains conservative and requires an explicit PURE annotation.
 *
 * JSX is not special: a transpiled factory call receives the same fresh props
 * object and is covered by the same capability check.
 */
describe('static eval with an opaque module-level call consuming the binding', () => {
  const expectResolved = (cssText: string) => {
    expect(cssText).toContain('padding:12px');
  };

  it('does not trust a built-in conversion of the whole mutable object', async () => {
    await expect(runStatic(source(OBJECT, CALL_WHOLE, TAG))).rejects.toThrow(
      'eval.strategy: "static"'
    );
  });

  it.each([
    ['the imported object itself', CALL_IMPORTED_WHOLE],
    ['a fresh container retaining the imported object', CALL_NESTED_OBJECT],
  ])('does not resolve when a call receives %s', async (_description, call) => {
    await expect(
      runStatic(importedSource(call, TAG), importedModules)
    ).rejects.toThrow('eval.strategy: "static"');
  });

  it('resolves when an opaque call takes the primitive member the tag reads', async () => {
    const result = await runStatic(
      importedSource(CALL_MEMBER, TAG),
      importedModules
    );
    expectResolved(result.cssText);
  });

  it('resolves when an opaque call takes another primitive member', async () => {
    const result = await runStatic(
      importedSource(CALL_OTHER_MEMBER, TAG),
      importedModules
    );
    expectResolved(result.cssText);
  });

  it('resolves when a fresh object only contains primitive projections', async () => {
    const result = await runStatic(
      importedSource(CALL_OBJECT, TAG),
      importedModules
    );
    expectResolved(result.cssText);
  });

  it('resolves when a fresh array only contains primitive projections', async () => {
    const result = await runStatic(
      importedSource(CALL_ARRAY, TAG),
      importedModules
    );
    expectResolved(result.cssText);
  });

  it.each([
    ['a primitive projection', CALL_MEMBER],
    ['two sequential primitive projections', `${CALL_MEMBER}\n${CALL_MEMBER}`],
    ['a fresh object of primitive projections', CALL_OBJECT],
    ['a fresh array of primitive projections', CALL_ARRAY],
  ])(
    'resolves a local root constant when an opaque call receives %s',
    async (_description, call) => {
      const result = await runStatic(
        localSource(OBJECT, call, TAG),
        localModules
      );
      expectResolved(result.cssText);
    }
  );

  it('does not resolve a local root constant passed as a whole object', async () => {
    await expect(
      runStatic(localSource(OBJECT, CALL_IMPORTED_WHOLE, TAG), localModules)
    ).rejects.toThrow('eval.strategy: "static"');
  });

  it('does not resolve a local root constant through mutating coercion', async () => {
    await expect(
      runStatic(
        localSource(
          dedent`
            const space = {
              s12: 12,
              s16: 16,
              toString() {
                this.s12 = 24;
                return 'space';
              },
            };
          `,
          'opaque(`${space}`);',
          TAG
        ),
        localModules
      )
    ).rejects.toThrow('eval.strategy: "static"');
  });

  it.each([
    ['undefined', 'undefined'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['a negative numeric literal', '-1'],
    ['a template built from a primitive projection', '`${space.s12}px`'],
    ['a binary primitive expression', 'space.s12 + 1'],
    ['a logical primitive expression', 'space.s12 || 1'],
    ['a conditional primitive expression', 'true ? space.s12 : 1'],
  ])(
    'resolves when a fresh object also contains %s',
    async (_description, value) => {
      const result = await runStatic(
        importedSource(CALL_OBJECT_WITH_PRIMITIVE(value), TAG),
        importedModules
      );
      expectResolved(result.cssText);
    }
  );

  it.each([
    ['template coercion', '`${space}px`'],
    ['binary coercion', 'space + ""'],
    ['unary coercion', '+space'],
    ['a logical object result', 'space || 1'],
    ['a conditional object result', 'true ? space : 1'],
  ])(
    'does not allow %s through a fresh container',
    async (_description, value) => {
      await expect(
        runStatic(
          importedSource(CALL_OBJECT_WITH_PRIMITIVE(value), TAG),
          importedModules
        )
      ).rejects.toThrow('eval.strategy: "static"');
    }
  );

  it.each(['undefined', 'NaN', 'Infinity'])(
    'does not mistake a shadowed %s binding for the global primitive',
    async (name) => {
      await expect(
        runStatic(
          importedSource(
            `const ${name} = space;`,
            CALL_OBJECT_WITH_PRIMITIVE(name),
            TAG
          ),
          importedModules
        )
      ).rejects.toThrow('eval.strategy: "static"');
    }
  );

  it('resolves with a transpiled JSX factory call', async () => {
    const result = await runStatic(
      importedSource(CALL_TRANSPILED_JSX, TAG),
      importedModules
    );
    expectResolved(result.cssText);
  });

  it.each([
    ['Object.keys', CALL_OBJECT_KEYS],
    ['Object.fromEntries', CALL_OBJECT_FROM_ENTRIES],
    ['an array method', CALL_ARRAY_METHOD],
    ['a local helper', CALL_VIA_LOCAL],
  ])('does not infer that %s is read-only', async (_description, call) => {
    await expect(runStatic(source(OBJECT, call, TAG))).rejects.toThrow(
      'eval.strategy: "static"'
    );
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

  it('applies a PURE annotation to calls that compute a chained callee', async () => {
    const result = await runStatic(
      dedent`
        ${HEADER}
        import { factory } from './runtime';
        import { space } from './tokens';

        /*#__PURE__*/ factory(space)();
        ${TAG}
      `,
      {
        'runtime.ts': dedent`
          export const factory = (value: unknown) => () => String(value);
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
    ).rejects.toThrow(
      'an earlier call may mutate a value used by this interpolation'
    );
  });

  it('does not hide an opaque call in a deferred callee callback', async () => {
    await expect(
      runStatic(
        dedent`
          ${HEADER}
          import { factory, mutate } from './runtime';
          import { space } from './tokens';

          export const run = /*#__PURE__*/ factory(() => {
            mutate(space);
            return css\`padding: ${'${space.s12}'}px;\`;
          })();
        `,
        {
          'runtime.ts': dedent`
            export const factory = (callback: () => unknown) => callback;
            export const mutate = (value: unknown) => value;
          `,
          'tokens.ts': OBJECT.replace('const ', 'export const '),
        }
      )
    ).rejects.toThrow(
      'an earlier call may mutate a value used by this interpolation'
    );
  });
});
