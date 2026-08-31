import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);

export interface ICache {
  get: (key: string) => Promise<string>;
  getDependencies?: (key: string) => Promise<string[]>;
  set: (key: string, value: string) => Promise<void>;
  setDependencies?: (key: string, value: string[]) => Promise<void>;
}

const CACHE_STATE_KEY = Symbol.for('@wyw-in-js/webpack-loader.cache');

const stripQueryAndHash = (request: string) => {
  const queryIdx = request.indexOf('?');
  const hashIdx = request.indexOf('#');

  if (queryIdx === -1) {
    return hashIdx === -1 ? request : request.slice(0, hashIdx);
  }
  if (hashIdx === -1) return request.slice(0, queryIdx);

  return request.slice(0, Math.min(queryIdx, hashIdx));
};

/**
 * Webpack/Rspack may report the same Windows file with different separators
 * or drive-letter casing, and outputCssLoader may keep a query suffix.
 * Normalize those variants so the main loader and outputCssLoader share a key.
 */
export const toCacheKey = (resourcePath: string): string => {
  const posixPath = stripQueryAndHash(resourcePath).replace(/\\/g, '/');
  return posixPath.replace(
    /^([A-Z]):\//,
    (_match, drive: string) => `${drive.toLowerCase()}:/`
  );
};

type CacheModuleState = {
  cacheProviderIds: WeakMap<ICache, string>;
  cacheProviderSeq: number;
  cacheProvidersById: Map<string, ICache>;
  memoryCache: MemoryCache;
};

const getCacheModuleState = (): CacheModuleState => {
  const registry = globalThis as typeof globalThis & {
    [CACHE_STATE_KEY]?: CacheModuleState;
  };

  const existing = registry[CACHE_STATE_KEY];
  if (existing) {
    return existing;
  }

  const created: CacheModuleState = {
    cacheProviderIds: new WeakMap(),
    cacheProviderSeq: 0,
    cacheProvidersById: new Map(),
    memoryCache: new MemoryCache(),
  };
  registry[CACHE_STATE_KEY] = created;
  return created;
};

export const registerCacheProvider = (cacheProvider: ICache): string => {
  const state = getCacheModuleState();
  const knownId = state.cacheProviderIds.get(cacheProvider);
  if (knownId) {
    return knownId;
  }

  state.cacheProviderSeq += 1;
  const id = `${state.cacheProviderSeq}`;
  state.cacheProviderIds.set(cacheProvider, id);
  state.cacheProvidersById.set(id, cacheProvider);
  return id;
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

export const memoryCache = getCacheModuleState().memoryCache;

/**
 * return cache instance from `options.cacheProvider`
 * @param cacheProvider string | ICache | undefined
 * @returns ICache instance
 */
export const getCacheInstance = async (
  cacheProvider: string | ICache | undefined,
  cacheProviderId?: string | undefined
): Promise<ICache> => {
  if (cacheProviderId) {
    const cacheProviderInstance =
      getCacheModuleState().cacheProvidersById.get(cacheProviderId);
    if (!cacheProviderInstance) {
      throw new Error(`Invalid cache provider id: ${cacheProviderId}`);
    }

    return cacheProviderInstance;
  }

  if (!cacheProvider) {
    return getCacheModuleState().memoryCache;
  }
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
  throw new Error(`Invalid cache provider: ${cacheProvider}`);
};
