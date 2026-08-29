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
  export const space = { s4: 4, s8: 8, s12: 12, s16: 16 };
  export const themeVars = {
    warning: 'var(--warning)',
    textColor: 'var(--text)',
    success: 'var(--success)',
  };
`;

const ICONS = dedent`
  export const jsx = (type: unknown, props: unknown) => ({ type, props });
  export const WarningTriangleFilled = (props: unknown) => props;
  export const Spinner = (props: unknown) => props;
  export const CheckCircleFilled = (props: unknown) => props;
`;

const runStatic = async (source: string) => {
  const root = mkdtempSync(join(tmpdir(), 'wyw-toast-record-'));
  const entryFile = join(root, 'entry.tsx');
  writeFileSync(join(root, 'tokens.ts'), TOKENS);
  writeFileSync(join(root, 'icons.tsx'), ICONS);
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

const HEADER = dedent`
  import { css } from 'test-css-processor';
  import {
    CheckCircleFilled,
    jsx,
    Spinner,
    WarningTriangleFilled,
  } from './icons';
  import { space, themeVars } from './tokens';
`;

const TAGS = dedent`
  export const rootCss = css\`box-sizing: border-box;\`;
  export const rootLineCss = css\`gap: \${space.s12}px; padding: \${space.s12}px \${space.s16}px;\`;
  export const cartCardCss = css\`gap: \${space.s8}px; padding: \${space.s12}px;\`;
  export const messageCss = css\`gap: \${space.s4}px;\`;
`;

/** The record as it was written: icons built inline at module scope. */
const INLINE_RECORD = dedent`
  const defaultPropsPerType = {
    info: {},
    error: {
      icon: jsx(WarningTriangleFilled, { color: themeVars.warning }),
      duration: 10000,
      dismissable: true,
    },
    loading: { icon: jsx(Spinner, { color: themeVars.textColor }) },
    success: { icon: jsx(CheckCircleFilled, { color: themeVars.success }) },
  };
`;

/** The applied workaround: each icon behind a one-line component. */
const WRAPPED_RECORD = dedent`
  const ErrorIcon = () => jsx(WarningTriangleFilled, { color: themeVars.warning });
  const LoadingIcon = () => jsx(Spinner, { color: themeVars.textColor });
  const SuccessIcon = () => jsx(CheckCircleFilled, { color: themeVars.success });

  const defaultPropsPerType = {
    info: {},
    error: { icon: jsx(ErrorIcon, {}), duration: 10000, dismissable: true },
    loading: { icon: jsx(LoadingIcon, {}) },
    success: { icon: jsx(SuccessIcon, {}) },
  };
`;

const USE = 'export const use = defaultPropsPerType;';

const source = (record: string) =>
  [HEADER, '', record, '', TAGS, '', USE].join('\n');

/**
 * The real-world shape this was reduced from: a design system's toast module.
 *
 * A `Record<ToastType, Partial<ToastProps>>` builds its icons inline at module
 * scope. Each `jsx(...)` is an eagerly-evaluated opaque call consuming
 * `themeVars`, which poisons every interpolation in the file -- including the
 * `space.*` ones that never touch the record. All four tags below fail
 * together, matching the six `_exp` refs the app's Vite build reported.
 *
 * The JSX is written here as the `jsx(...)` calls it transpiles to: the source
 * form is irrelevant, and the harness does not transpile JSX itself.
 *
 * See transform.static-opaque-call-poisons-binding.test.ts for the reduced
 * ingredients; this file guards the shape an app actually hits.
 */
describe('static eval with a module-level record of eagerly built icons', () => {
  it('resolves every tag with icons built inline in the record', async () => {
    const result = await runStatic(source(INLINE_RECORD));

    expect(result.cssText).toContain('box-sizing:border-box');
    expect(result.cssText).toContain('gap:12px');
    expect(result.cssText).toContain('padding:12px 16px');
    expect(result.cssText).toContain('gap:8px');
    expect(result.cssText).toContain('gap:4px');
  });

  // Control: the workaround applied downstream, which resolves today.

  it('resolves when each icon sits behind a wrapper component', async () => {
    const result = await runStatic(source(WRAPPED_RECORD));

    expect(result.cssText).toContain('gap:12px');
    expect(result.cssText).toContain('padding:12px 16px');
    expect(result.cssText).toContain('gap:8px');
    expect(result.cssText).toContain('gap:4px');
  });
});
