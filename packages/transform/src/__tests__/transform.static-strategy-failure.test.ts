import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import { SourceMapGenerator, type RawSourceMap } from 'source-map';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';

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

const runStatic = (
  root: string,
  entryFile: string,
  inputSourceMap?: RawSourceMap,
  strategy: 'hybrid' | 'static' = 'static'
) =>
  transform(
    {
      cache: new TransformCacheCollection(),
      options: {
        filename: entryFile,
        inputSourceMap,
        root,
        pluginOptions: {
          configFile: false,
          eval: { strategy },
          tagResolver: (s: string, t: string) =>
            s === 'test-css-processor' && t === 'css' ? processorFile : null,
        },
      },
    },
    readFileSync(entryFile, 'utf8'),
    createResolver()
  );

describe('eval.strategy "static" failure diagnostics', () => {
  it('reports the standard strategy failure for snapshot-local writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const entryFile = join(root, 'entry.js');

    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `export function Component() {`,
        `  let { width } = { width: 1 };`,
        '  const className = css`--widths: ${width}:${(width = 2)}:${width};`;',
        `  return [className, width];`,
        `}`,
      ].join('\n')
    );

    try {
      await runStatic(root, entryFile);
      throw new Error('expected static strategy to fail');
    } catch (error) {
      const { message } = error as Error;
      expect(message).toContain('eval.strategy: "static"');
      expect(message).toContain('could not be resolved at build time');
      expect(message).not.toContain('local snapshot depends');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['for-of', '(() => { for (width of [2]) {} return width; })()'],
    ['for-in', '(() => { for (width in { two: 1 }) {} return width; })()'],
  ])(
    'reports the standard strategy failure for an eagerly executed snapshot-local %s target',
    async (_name, expression) => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
      const entryFile = join(root, 'entry.js');

      writeFileSync(
        entryFile,
        [
          `import { css } from 'test-css-processor';`,
          `export function Component() {`,
          `  let { width } = { width: 1 };`,
          `  const className = css\`--width: \${${expression}};\`;`,
          `  return [className, width];`,
          `}`,
        ].join('\n')
      );

      try {
        await runStatic(root, entryFile);
        throw new Error('expected static strategy to fail');
      } catch (error) {
        const { message } = error as Error;
        expect(message).toContain('eval.strategy: "static"');
        expect(message).toContain('could not be resolved at build time');
        expect(message).not.toContain('local snapshot depends');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('names the original interpolation and its import source instead of bare _exp placeholders', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const genFile = join(root, 'theme.js');
    const entryFile = join(root, 'entry.js');

    writeFileSync(
      genFile,
      [
        `export const neutral = { light: { "--c": "rgb(1,1,1)" } };`,
        // Not statically foldable -> stays an eval dependency.
        `export const warm = { light: { "--c": "rgb(" + Date.now() + ")" } };`,
      ].join('\n')
    );
    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `import { neutral, warm } from './theme.js';`,
        'export const className = css`',
        '  html { ${neutral.light} }',
        '  html.warm { ${warm.light} }',
        '`;',
      ].join('\n')
    );

    try {
      await runStatic(root, entryFile);
      throw new Error('expected static strategy to fail');
    } catch (error) {
      const { message } = error as Error;
      expect(message).toContain('eval.strategy: "static"');
      // The actionable bits: the source expression and where it came from.
      expect(message).toContain('warm.light');
      expect(message).toContain('from ./theme.js');
      // Source expression leads; the _exp placeholder is not shown when known.
      expect(message).not.toMatch(/-\s+_exp/);
      // A specific reason replaces the generic catch-all sentence.
      expect(message).toContain("isn't statically analyzable");
      expect(message).not.toContain('They reference runtime-only values');
      // The unresolvable neutral.light DID resolve, so must not be listed.
      expect(message).not.toContain('neutral.light');
      // Hint to the escape hatch.
      expect(message).toContain('hybrid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still gives the actionable hint when only a placeholder name is available', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const entryFile = join(root, 'entry.js');

    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `const spacing = Date.now();`,
        'export const className = css`',
        '  margin: ${spacing}px;',
        '`;',
      ].join('\n')
    );

    try {
      await runStatic(root, entryFile);
      throw new Error('expected static strategy to fail');
    } catch (error) {
      const { message } = error as Error;
      expect(message).toContain('eval.strategy: "static"');
      expect(message).toContain('could not be resolved at build time');
      // No source expression is available here, so the _exp placeholder is the
      // fallback and the generic catch-all sentence is retained.
      expect(message).toMatch(/-\s+_exp/);
      expect(message).toContain('They reference runtime-only values');
      expect(message).toContain('hybrid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('points to an opaque call that can be annotated as PURE', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const entryFile = join(root, 'entry.js');
    writeFileSync(
      join(root, 'tokens.js'),
      'export const space = { medium: 12 };'
    );
    writeFileSync(
      join(root, 'runtime.js'),
      'export const factory = () => (value) => String(value);'
    );
    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `import { factory } from './runtime.js';`,
        `import { space } from './tokens.js';`,
        `factory()(space);`,
        'export const className = css`padding: ${space.medium}px;`;',
        'export const otherClassName = css`margin: ${space.medium}px;`;',
      ].join('\n')
    );

    try {
      await runStatic(root, entryFile);
      throw new Error('expected static strategy to fail');
    } catch (error) {
      const { message } = error as Error;
      expect(message).toContain(`${entryFile}:4:1`);
      expect(message).toContain('/*#__PURE__*/ factory()(space)');
      expect(message).toContain('side-effect-free');
      expect(message.split('/*#__PURE__*/ factory()(space)')).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('points to an opaque call that prevents resolving a local binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const entryFile = join(root, 'entry.js');
    writeFileSync(
      join(root, 'runtime.js'),
      `export const opaque = (value) => String(value);`
    );
    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `import { opaque } from './runtime.js';`,
        `const space = { medium: 12 };`,
        `opaque(space);`,
        'export const className = css`padding: ${space.medium}px;`;',
      ].join('\n')
    );

    try {
      await runStatic(root, entryFile);
      throw new Error('expected static strategy to fail');
    } catch (error) {
      const { message } = error as Error;
      expect(message).toContain(`${entryFile}:4:1`);
      expect(message).toContain('/*#__PURE__*/ opaque(space)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the local binding after applying the suggested PURE annotation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const entryFile = join(root, 'entry.js');
    writeFileSync(
      join(root, 'runtime.js'),
      `export const opaque = (value) => String(value);`
    );
    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `import { opaque } from './runtime.js';`,
        `const space = { medium: 12 };`,
        `/*#__PURE__*/ opaque(space);`,
        'export const className = css`padding: ${space.medium}px;`;',
      ].join('\n')
    );

    try {
      const result = await runStatic(root, entryFile);
      expect(result.cssText).toContain('padding:12px');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not suggest a local call when annotating it would not resolve the value', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const entryFile = join(root, 'entry.js');
    writeFileSync(
      join(root, 'runtime.js'),
      `export const opaque = (value) => String(value);`
    );
    const writeEntry = (annotation = '') =>
      writeFileSync(
        entryFile,
        [
          `import { css } from 'test-css-processor';`,
          `import { opaque } from './runtime.js';`,
          `const space = makeSpace();`,
          `${annotation}opaque(space);`,
          'export const className = css`padding: ${space.medium}px;`;',
        ].join('\n')
      );
    writeEntry();

    try {
      let failure: unknown;
      try {
        await runStatic(root, entryFile);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const { message } = failure as Error;
      expect(message).not.toContain('Calls that may be safe to annotate');
      expect(message).not.toContain('/*#__PURE__*/ opaque(space)');

      writeEntry('/*#__PURE__*/ ');
      await expect(runStatic(root, entryFile)).rejects.toThrow(
        'eval.strategy: "static"'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not surface PURE hints when hybrid fallback is available', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const entryFile = join(root, 'entry.js');
    writeFileSync(
      join(root, 'runtime.js'),
      `export const opaque = (value) => String(value);`
    );
    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `import { opaque } from './runtime.js';`,
        `const space = { medium: 12 };`,
        `opaque(space);`,
        'export const className = css`padding: ${space.medium}px;`;',
      ].join('\n')
    );

    try {
      const result = await runStatic(root, entryFile, undefined, 'hybrid');
      expect(result.cssText).toContain('padding:12px');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('only points to the mutation guard that actually failed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const entryFile = join(root, 'entry.js');
    writeFileSync(
      join(root, 'tokens.js'),
      [
        `export const alias = { className: 'safe', nested: {} };`,
        `export const source = { width: 12 };`,
      ].join('\n')
    );
    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `import { alias, source } from './tokens.js';`,
        `mutate(alias.className);`,
        `mutate(alias.nested);`,
        'export const className = css`width: ${source.width}px;`;',
      ].join('\n')
    );

    try {
      await runStatic(root, entryFile);
      throw new Error('expected static strategy to fail');
    } catch (error) {
      const { message } = error as Error;
      expect(message).toContain('/*#__PURE__*/ mutate(alias.nested)');
      expect(message).not.toContain('/*#__PURE__*/ mutate(alias.className)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('omits guardable calls when an unconditional receiver call blocks extraction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const entryFile = join(root, 'entry.js');
    writeFileSync(
      join(root, 'tokens.js'),
      [
        `export const alias = { className: 'safe', width: 12, method() {} };`,
      ].join('\n')
    );
    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `import { alias } from './tokens.js';`,
        `mutate(alias.className);`,
        `alias.method();`,
        'export const className = css`width: ${alias.width}px;`;',
      ].join('\n')
    );

    try {
      await runStatic(root, entryFile);
      throw new Error('expected static strategy to fail');
    } catch (error) {
      const { message } = error as Error;
      expect(message).toContain('/*#__PURE__*/ alias.method()');
      expect(message).not.toContain('/*#__PURE__*/ mutate(alias.className)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('maps a PURE hint through a sparse map with no exact end segment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const entryFile = join(root, 'entry.js');
    const originalFile = join(root, 'entry.tsx');
    const originalSource = [
      `import { css } from 'test-css-processor';`,
      `import { factory } from './runtime.js';`,
      `import { space } from './tokens.js';`,
      `factory()(space);`,
      'export const className = css`padding: ${space.medium}px;`;',
    ].join('\n');
    const generatedSource = `// generated\n${originalSource}`;
    const sourceMap = new SourceMapGenerator({ file: entryFile });
    originalSource.split('\n').forEach((line, index) => {
      sourceMap.addMapping({
        generated: { column: 0, line: index + 2 },
        original: { column: 0, line: index + 1 },
        source: originalFile,
      });
      sourceMap.addMapping({
        generated: {
          column:
            line === 'factory()(space);' ? 'factory()('.length : line.length,
          line: index + 2,
        },
        original: {
          column:
            line === 'factory()(space);' ? 'factory()('.length : line.length,
          line: index + 1,
        },
        source: originalFile,
      });
    });
    sourceMap.setSourceContent(originalFile, originalSource);
    writeFileSync(entryFile, generatedSource);
    writeFileSync(
      join(root, 'runtime.js'),
      `export const factory = () => (value) => String(value);`
    );
    writeFileSync(
      join(root, 'tokens.js'),
      `export const space = { medium: 12 };`
    );

    try {
      await runStatic(root, entryFile, sourceMap.toJSON() as RawSourceMap);
      throw new Error('expected static strategy to fail');
    } catch (error) {
      const { message } = error as Error;
      expect(message).toContain(`${originalFile}:4:1`);
      expect(message).toContain('/*#__PURE__*/ factory()(space)');
      expect(message).not.toContain(`${entryFile}:5:1`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('suppresses a hint when a source map cannot prove its editable range', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const entryFile = join(root, 'entry.js');
    const originalFile = join(root, 'entry.tsx');
    const generatedSource = [
      `import { css } from 'test-css-processor';`,
      `import { factory } from './runtime.js';`,
      `import { space } from './tokens.js';`,
      `factory()(space);`,
      'export const className = css`padding: ${space.medium}px;`;',
    ].join('\n');
    const originalSource = generatedSource.replace(
      'factory()(space);',
      '<Factory value={space} />;'
    );
    const sourceMap = new SourceMapGenerator({ file: entryFile });
    sourceMap.addMapping({
      generated: { column: 0, line: 4 },
      original: { column: 0, line: 4 },
      source: originalFile,
    });
    sourceMap.addMapping({
      generated: { column: 'factory()(space)'.length, line: 4 },
      original: { column: '<Factory value={space} />'.length, line: 4 },
      source: originalFile,
    });
    sourceMap.setSourceContent(originalFile, originalSource);
    writeFileSync(entryFile, generatedSource);
    writeFileSync(
      join(root, 'runtime.js'),
      `export const factory = () => (value) => String(value);`
    );
    writeFileSync(
      join(root, 'tokens.js'),
      `export const space = { medium: 12 };`
    );

    try {
      await runStatic(root, entryFile, sourceMap.toJSON() as RawSourceMap);
      throw new Error('expected static strategy to fail');
    } catch (error) {
      const { message } = error as Error;
      expect(message).not.toContain('Calls that may be safe to annotate');
      expect(message).not.toContain('/*#__PURE__*/');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('distinguishes a missing export (undefined) from a genuinely non-serializable value', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const genFile = join(root, 'theme.js');
    const entryFile = join(root, 'entry.js');

    // themeVars is exported but emptied, so member access yields undefined —
    // the "emptied module" shape, not a non-serializable value.
    writeFileSync(genFile, `export const themeVars = {};\n`);
    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `import { themeVars } from './theme.js';`,
        'export const className = css`',
        '  color: ${themeVars.accentTextColor};',
        '`;',
      ].join('\n')
    );

    try {
      await runStatic(root, entryFile);
      throw new Error('expected static strategy to fail');
    } catch (error) {
      const { message } = error as Error;
      expect(message).toContain('themeVars.accentTextColor');
      expect(message).toContain('resolved to undefined');
      // Must NOT mislabel an emptied export as non-serializable.
      expect(message).not.toContain('non-serializable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dedupes repeated values and groups one shared cause', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const genFile = join(root, 'theme.js');
    const entryFile = join(root, 'entry.js');

    writeFileSync(genFile, `export const themeVars = {};\n`);
    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `import { themeVars } from './theme.js';`,
        'export const a = css`',
        '  color: ${themeVars.textColor};',
        '  outline-color: ${themeVars.textColor};', // duplicate of above
        '  background: ${themeVars.panelBg};',
        '`;',
        'export const b = css`',
        '  ${{',
        '    color: themeVars.textColor,',
        '    backgroundColor: themeVars.panelBg,',
        '  }}',
        '`;',
      ].join('\n')
    );

    try {
      await runStatic(root, entryFile);
      throw new Error('expected static strategy to fail');
    } catch (error) {
      const { message } = error as Error;
      // One shared-cause header, not repeated on every line.
      expect(message).toContain(
        'resolved to undefined (export missing or not exported) from ./theme.js:'
      );
      expect(message.match(/export missing or not exported/g)?.length).toBe(1);
      // The repeated themeVars.textColor collapses to a single counted line.
      expect(message).toContain('- themeVars.textColor (×2)');
      // Inline objects are kept verbatim (no lossy truncation).
      expect(message).toContain('backgroundColor: themeVars.panelBg');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
