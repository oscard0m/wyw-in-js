import { createRequire } from 'module';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const nodeRequire = createRequire(import.meta.url);

export interface ICache {
  get: (key: string) => Promise<string>;
  getDependencies?: (key: string) => Promise<string[]>;
  set: (key: string, value: string) => Promise<void>;
  setDependencies?: (key: string, value: string[]) => Promise<void>;
}

// Rspack can evaluate the two loaders in separate module graphs. Keep shared
// runtime state on the compiler instead of leaking cache providers globally.
const COMPILER_CACHE_STATE_KEY = Symbol.for(
  '@wyw-in-js/webpack-loader.compiler-cache.v3'
);

const isWindowsAbsolutePath = (
  resourcePath: string,
  platform: NodeJS.Platform = process.platform
): boolean =>
  /^[A-Za-z]:[\\/]/.test(resourcePath) ||
  /^\\\\/.test(resourcePath) ||
  (platform === 'win32' && /^\/\//.test(resourcePath));

// Webpack's contextify expects native Windows paths. Only remove the extended
// namespace that would otherwise make `?` look like a request query delimiter.
export const toWebpackRequestPath = (
  filePath: string,
  platform: NodeJS.Platform = process.platform
): string => {
  if (platform === 'win32' && /^\/\/[^?/]/.test(filePath)) {
    return filePath.replace(/\//g, '\\');
  }

  if (!isWindowsAbsolutePath(filePath, platform)) {
    return filePath;
  }

  const namespacePrefix = /^(?:\\\\\?\\|\/\/\?\/)/.exec(filePath);
  if (!namespacePrefix) {
    return filePath;
  }

  const namespacedPath = filePath.slice(namespacePrefix[0].length);
  if (
    namespacedPath
      .split(/[\\/]/)
      .some((segment) => segment.length > 0 && /[. ]$/.test(segment))
  ) {
    throw new Error(
      `Unsupported Windows extended path with trailing dot or space: ${filePath}`
    );
  }

  const namespacedUnc = /^UNC[\\/](.*)$/i.exec(namespacedPath);
  if (namespacedUnc) {
    return `\\\\${namespacedUnc[1].replace(/\//g, '\\')}`;
  }

  if (/^[A-Za-z]:[\\/]/.test(namespacedPath)) {
    return namespacedPath;
  }

  throw new Error(`Unsupported Windows extended path namespace: ${filePath}`);
};

/**
 * Webpack/Rspack may report the same Windows file with different separators
 * or drive-letter casing. Normalize those variants so the main loader and
 * outputCssLoader share a key without changing valid POSIX filenames.
 */
export const toCacheKey = (
  resourcePath: string,
  platform: NodeJS.Platform = process.platform
): string => {
  if (!isWindowsAbsolutePath(resourcePath, platform)) {
    return resourcePath;
  }

  const posixPath = toWebpackRequestPath(resourcePath, platform).replace(
    /\\/g,
    '/'
  );

  return posixPath.replace(
    /^([A-Z]):\//,
    (_match, drive: string) => `${drive.toLowerCase()}:/`
  );
};

// memory cache, which is the default cache implementation in WYW-in-JS

class MemoryCache implements ICache {
  private cache: Map<string, string> = new Map();

  private dependenciesCache: Map<string, string[]> = new Map();

  public get(key: string): Promise<string> {
    return Promise.resolve(this.cache.get(toCacheKey(key)) ?? '');
  }

  public getDependencies(key: string): Promise<string[]> {
    return Promise.resolve(this.dependenciesCache.get(toCacheKey(key)) ?? []);
  }

  public set(key: string, value: string): Promise<void> {
    this.cache.set(toCacheKey(key), value);
    return Promise.resolve();
  }

  public setDependencies(key: string, value: string[]): Promise<void> {
    this.dependenciesCache.set(toCacheKey(key), value);
    return Promise.resolve();
  }
}

type CompilerCacheState = {
  cacheProvidersByToken: Map<string, ICache>;
  memoryCache: ICache;
};

export const memoryCache = new MemoryCache();

const localCacheState: CompilerCacheState = {
  cacheProvidersByToken: new Map(),
  memoryCache,
};

const getCompilerCacheState = (cacheHost?: object): CompilerCacheState => {
  if (!cacheHost) {
    return localCacheState;
  }

  const host = cacheHost as typeof cacheHost & {
    [COMPILER_CACHE_STATE_KEY]?: CompilerCacheState;
  };

  const existing = host[COMPILER_CACHE_STATE_KEY];
  if (existing) {
    return existing;
  }

  const created: CompilerCacheState = {
    cacheProvidersByToken: new Map(),
    memoryCache: new MemoryCache(),
  };
  host[COMPILER_CACHE_STATE_KEY] = created;
  return created;
};

export const registerCacheProvider = (
  cacheProvider: ICache,
  cacheProviderToken: string,
  cacheHost?: object
): boolean => {
  const registry = getCompilerCacheState(cacheHost);
  const existingCacheProvider =
    registry.cacheProvidersByToken.get(cacheProviderToken);
  if (existingCacheProvider && existingCacheProvider !== cacheProvider) {
    return false;
  }

  registry.cacheProvidersByToken.set(cacheProviderToken, cacheProvider);
  return true;
};

export const clearCacheProviderRegistry = (cacheHost: object): void => {
  const host = cacheHost as typeof cacheHost & {
    [COMPILER_CACHE_STATE_KEY]?: CompilerCacheState;
  };
  delete host[COMPILER_CACHE_STATE_KEY];
};

export type OutputCssPayload = {
  cssText: string;
};

const OUTPUT_CSS_PAYLOAD_VERSION = 'v1.';

export const encodeOutputCssPayload = (payload: OutputCssPayload): string =>
  `${OUTPUT_CSS_PAYLOAD_VERSION}${deflateRawSync(
    Buffer.from(JSON.stringify(payload))
  ).toString('base64url')}`;

export const decodeOutputCssPayload = (
  encodedPayload: string
): OutputCssPayload => {
  if (!encodedPayload.startsWith(OUTPUT_CSS_PAYLOAD_VERSION)) {
    throw new Error('Invalid output CSS payload');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(
      inflateRawSync(
        Buffer.from(
          encodedPayload.slice(OUTPUT_CSS_PAYLOAD_VERSION.length),
          'base64url'
        )
      ).toString('utf8')
    );
  } catch {
    throw new Error('Invalid output CSS payload');
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('cssText' in payload) ||
    typeof payload.cssText !== 'string'
  ) {
    throw new Error('Invalid output CSS payload');
  }

  return {
    cssText: payload.cssText,
  };
};

/**
 * return cache instance from `options.cacheProvider`
 * @param cacheProvider string | ICache | undefined
 * @returns ICache instance
 */
export const getCacheInstance = async (
  cacheProvider: string | ICache | undefined,
  cacheHost?: object,
  cacheProviderToken?: string
): Promise<ICache> => {
  if (typeof cacheProvider === 'string') {
    return nodeRequire(cacheProvider);
  }
  if (
    typeof cacheProvider === 'object' &&
    'get' in cacheProvider &&
    'set' in cacheProvider
  ) {
    return cacheProvider;
  }
  if (cacheProvider !== undefined) {
    throw new Error(`Invalid cache provider: ${cacheProvider}`);
  }

  const registry = getCompilerCacheState(cacheHost);
  if (cacheProviderToken) {
    const registeredCacheProvider =
      registry.cacheProvidersByToken.get(cacheProviderToken);
    if (registeredCacheProvider) {
      return registeredCacheProvider;
    }
  }

  return registry.memoryCache;
};
