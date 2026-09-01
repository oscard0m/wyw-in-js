import fs from 'fs';
import path from 'path';

import type { RawSourceMap } from 'source-map';
import type { LoaderContext, RawLoaderDefinitionFunction } from 'webpack';

import { logger } from '@wyw-in-js/shared';
import type {
  DependencyResolution,
  PluginOptions,
  Result,
} from '@wyw-in-js/transform';
import { transform, TransformCacheCollection } from '@wyw-in-js/transform';

import { makeCssModuleGlobal } from './css-modules';
import { writeFileIfChanged } from './file-utils';
import { insertImportStatement } from './insert-import';

const DEFAULT_EXTENSION = '.wyw-in-js.module.css';
const CSS_OUTPUT_QUERY = '__wyw_css';

const stripQueryAndHash = (request: string) => {
  const queryIdx = request.indexOf('?');
  const hashIdx = request.indexOf('#');

  if (queryIdx === -1) {
    return hashIdx === -1 ? request : request.slice(0, hashIdx);
  }
  if (hashIdx === -1) return request.slice(0, queryIdx);

  return request.slice(0, Math.min(queryIdx, hashIdx));
};

export type LoaderOptions = {
  cssOutputMode?: 'sidecar' | 'query';
  keepComments?: boolean;
  outputCss?: boolean;
  prefixer?: boolean;
  sourceMap?: boolean;
} & Partial<PluginOptions>;

type Loader = RawLoaderDefinitionFunction<LoaderOptions>;
type ResolveFn = ReturnType<LoaderContext<LoaderOptions>['getResolve']>;

type Resolver = (
  what: string,
  importer: string,
  stack?: string[]
) => Promise<string>;

const cache = new TransformCacheCollection();

// Stable resolver scope shared by every loader invocation in this process,
// mirroring webpack-loader's per-compiler ResolverScope. The eval broker and
// its runner child process are keyed on `asyncResolveKey`; passing a fresh
// per-file closure to transform() without a key would rotate that key every
// file and force a runner respawn per transformed file. Each invocation
// registers its own resolver here (keyed by resourcePath) so eval-time
// resolutions still hit the loader context of the file being transformed.
const ASYNC_RESOLVE_KEY = 'turbopack-loader';
// Keyed by resourcePath only. Unlike webpack-loader there is no compiler
// handle to scope by, so two concurrent compilations transforming the same
// file (e.g. Next.js server and client) overwrite each other's entry and a
// resolution may be routed through the other compilation's loader context.
// Entries are removed when their loader invocation settles (see the
// transform() finally below); webpack-loader instead clears its map on
// compiler done/failed hooks, which Turbopack does not expose.
const resolvers = new Map<string, Resolver>();

const getResolverKey = (importer: string, stack: string[]): string => {
  const root = stack.length ? stack[stack.length - 1] : importer;
  return stripQueryAndHash(root);
};

const scopedAsyncResolve: Resolver = (what, importer, stack = [importer]) => {
  const resolverKeys = [
    getResolverKey(importer, stack),
    stripQueryAndHash(importer),
  ].filter((candidate, idx, all) => all.indexOf(candidate) === idx);

  const selectedResolvers = resolverKeys
    .map((resolverKey) => resolvers.get(resolverKey))
    .filter((resolver): resolver is Resolver => Boolean(resolver));

  if (selectedResolvers.length === 0) {
    throw new Error('No resolver found');
  }

  // Root and importer resolver side effects both matter for dependency
  // tracking, so keep them aligned and verify they agree on the answer.
  return Promise.all(
    selectedResolvers.map((resolver) => resolver(what, importer, stack))
  ).then((results) => {
    const firstResult = results[0];
    if (results.some((result) => result !== firstResult)) {
      throw new Error('Resolvers returned different results');
    }

    return firstResult;
  });
};

function convertSourceMap(
  value: RawSourceMap | string | null | undefined,
  filename: string
): RawSourceMap | undefined {
  if (typeof value === 'string' || !value) {
    return undefined;
  }

  return {
    ...value,
    file: value.file ?? filename,
    mappings: value.mappings ?? '',
    names: value.names ?? [],
    sources: value.sources ?? [],
    version: value.version ?? 3,
  };
}

async function resolveWith(
  resolve: ResolveFn,
  context: string,
  request: string
): Promise<string | false> {
  type ResolveCallback = (
    ctx: string,
    req: string,
    cb: (err: Error | null, result?: string) => void
  ) => void;
  type ResolveAsync = (ctx: string, req: string) => Promise<string | false>;

  if (typeof resolve !== 'function') return false;

  if (resolve.length >= 3) {
    return new Promise((ok, fail) => {
      (resolve as unknown as ResolveCallback)(
        context,
        request,
        (err, result) => {
          if (err) fail(err);
          else ok(result ?? false);
        }
      );
    });
  }

  return (resolve as unknown as ResolveAsync)(context, request);
}

const turbopackLoader: Loader = function turbopackLoader(
  content,
  inputSourceMap
) {
  const callbackFromAsync =
    typeof this.async === 'function' ? this.async() : undefined;
  const callback =
    typeof callbackFromAsync === 'function' ? callbackFromAsync : this.callback;

  if (typeof callback !== 'function') {
    throw new Error('Async loader callback is not available');
  }

  logger('turbopack-loader %s', this.resourcePath);

  const {
    sourceMap,
    keepComments,
    outputCss,
    cssOutputMode = 'sidecar',
    prefixer,
    configFile,
    ...rest
  } = this.getOptions() || {};

  if (configFile) {
    const configPath = path.isAbsolute(configFile)
      ? configFile
      : path.join(process.cwd(), configFile);
    this.addDependency(configPath);
  }

  const cssFileName = `${path.basename(
    this.resourcePath,
    path.extname(this.resourcePath)
  )}${DEFAULT_EXTENSION}`;
  const cssFilePath = path.join(path.dirname(this.resourcePath), cssFileName);
  const cssImportPath = `./${cssFileName}`;

  const resolveModule = this.getResolve({ dependencyType: 'esm' });

  const asyncResolve = async (token: string, importer: string) => {
    const importerPath = stripQueryAndHash(importer);
    const context = path.isAbsolute(importerPath)
      ? path.dirname(importerPath)
      : path.join(process.cwd(), path.dirname(importerPath));

    const result = await resolveWith(resolveModule, context, token);

    if (!result) {
      throw new Error(`Cannot resolve ${token} from ${context}`);
    }

    const filePath = stripQueryAndHash(result);
    if (path.isAbsolute(filePath)) {
      this.addDependency(filePath);
    }

    return result;
  };

  const resolverKey = stripQueryAndHash(this.resourcePath);
  resolvers.set(resolverKey, asyncResolve);

  const addResolvedDependency = async (
    dependency: string,
    dependencyResolutions: ReadonlyMap<string, string>
  ) => {
    const resolved = dependencyResolutions.get(dependency);
    if (resolved) {
      const filePath = stripQueryAndHash(resolved);
      if (path.isAbsolute(filePath)) {
        this.addDependency(filePath);
        return;
      }
    }

    await asyncResolve(dependency, this.resourcePath);
  };

  const transformServices = {
    options: {
      filename: this.resourcePath,
      inputSourceMap: convertSourceMap(inputSourceMap, this.resourcePath),
      pluginOptions: { configFile, ...rest },
      prefixer,
      keepComments,
      root: process.cwd(),
    },
    asyncResolveKey: ASYNC_RESOLVE_KEY,
    cache,
    emitWarning: (message: string) => {
      if (typeof this.emitWarning === 'function') {
        const warning = new Error(message);
        delete warning.stack;
        this.emitWarning(warning);
      }
    },
  };

  transform(transformServices, content.toString(), scopedAsyncResolve)
    .then(async (result: Result) => {
      const rawCssText = result.cssText ?? '';

      if (rawCssText.trim()) {
        let cssText = makeCssModuleGlobal(rawCssText);
        const dependencyResolutions = new Map(
          (result.dependencyResolutions ?? []).map(
            ({ resolved, source }: DependencyResolution) => [source, resolved]
          )
        );

        if (sourceMap && typeof result.cssSourceMapText !== 'undefined') {
          cssText += `\n/*# sourceMappingURL=data:application/json;base64,${Buffer.from(
            result.cssSourceMapText
          ).toString('base64')}*/\n`;
        }

        await Promise.all(
          (result.dependencies ?? []).map((dep) =>
            addResolvedDependency(dep, dependencyResolutions)
          )
        );

        if (outputCss) {
          callback(null, cssText);
          return;
        }

        let importPath = cssImportPath;
        if (cssOutputMode === 'query') {
          importPath = `./${path.basename(
            this.resourcePath
          )}?${CSS_OUTPUT_QUERY}`;
        } else {
          writeFileIfChanged(cssFilePath, cssText);
        }

        const importStatement = `import ${JSON.stringify(importPath)};`;
        const finalCode = insertImportStatement(result.code, importStatement);

        callback(null, finalCode, result.sourceMap ?? undefined);
        return;
      }

      if (outputCss) {
        callback(null, '');
        return;
      }

      if (cssOutputMode !== 'query' && fs.existsSync(cssFilePath)) {
        writeFileIfChanged(cssFilePath, '');
      }

      callback(null, result.code, result.sourceMap ?? undefined);
    })
    .catch((err: Error) => callback(err))
    .finally(() => {
      // The closure retains `this` (the whole LoaderContext); keeping it past
      // the invocation would grow the map unboundedly in watch mode. Evals
      // rooted in other files lose this file as an importer-side fallback,
      // which only skips duplicate dependency tracking on a loader run that
      // has already completed. The identity check keeps a concurrent
      // invocation for the same path (e.g. the css query pass) intact.
      if (resolvers.get(resolverKey) === asyncResolve) {
        resolvers.delete(resolverKey);
      }
    });
};

export default turbopackLoader;
