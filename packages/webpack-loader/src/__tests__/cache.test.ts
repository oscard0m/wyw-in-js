import {
  getCacheInstance,
  memoryCache,
  registerCacheProvider,
  toCacheKey,
} from '../cache';

const CACHE_STATE_KEY = Symbol.for('@wyw-in-js/webpack-loader.cache');

describe('webpack-loader cache keys', () => {
  it('normalizes Windows path variants and query/hash suffixes', () => {
    expect(toCacheKey('D:\\work\\app\\commonStyle.ts')).toBe(
      'd:/work/app/commonStyle.ts'
    );
    expect(toCacheKey('D:/work/app/commonStyle.ts')).toBe(
      'd:/work/app/commonStyle.ts'
    );
    expect(toCacheKey('d:/work/app/commonStyle.ts?wyw=wyw-in-js.css')).toBe(
      'd:/work/app/commonStyle.ts'
    );
    expect(toCacheKey('D:\\work\\app\\commonStyle.ts#hash')).toBe(
      'd:/work/app/commonStyle.ts'
    );
  });

  it('reads CSS written with a different Windows path representation', async () => {
    const cssText = '.title{color:red}';

    await memoryCache.set('D:\\work\\app\\commonStyle.ts', cssText);

    expect(await memoryCache.get('D:/work/app/commonStyle.ts')).toBe(cssText);
    expect(
      await memoryCache.get('d:\\work\\app\\commonStyle.ts?wyw=wyw-in-js.css')
    ).toBe(cssText);
  });

  it('keeps the default memory cache on globalThis for isolated loader graphs', async () => {
    const instance = await getCacheInstance(undefined);
    const state = (
      globalThis as typeof globalThis & {
        [CACHE_STATE_KEY]?: { memoryCache: unknown };
      }
    )[CACHE_STATE_KEY];

    expect(instance).toBe(memoryCache);
    expect(state?.memoryCache).toBe(memoryCache);
  });

  it('reuses a registered cache provider id across lookups', async () => {
    const id = registerCacheProvider(memoryCache);
    const again = registerCacheProvider(memoryCache);
    const resolved = await getCacheInstance(undefined, id);

    expect(again).toBe(id);
    expect(resolved).toBe(memoryCache);
  });
});
