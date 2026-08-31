import {
  clearCacheProviderRegistry,
  decodeOutputCssPayload,
  encodeOutputCssPayload,
  getCacheInstance,
  memoryCache,
  registerCacheProvider,
  toCacheKey,
  toWebpackRequestPath,
} from '../cache';

describe('webpack-loader cache keys', () => {
  it('normalizes Windows path variants', () => {
    expect(toCacheKey('D:\\work\\app\\commonStyle.ts')).toBe(
      'd:/work/app/commonStyle.ts'
    );
    expect(toCacheKey('D:/work/app/commonStyle.ts')).toBe(
      'd:/work/app/commonStyle.ts'
    );
    expect(toCacheKey('\\\\?\\D:\\work\\app\\commonStyle.ts')).toBe(
      'd:/work/app/commonStyle.ts'
    );
    expect(toCacheKey('\\\\?\\UNC\\server\\share\\commonStyle.ts')).toBe(
      '//server/share/commonStyle.ts'
    );
    expect(toCacheKey('//?/D:/work/app/commonStyle.ts', 'win32')).toBe(
      'd:/work/app/commonStyle.ts'
    );
    expect(toCacheKey('//?/UNC/server/share/commonStyle.ts', 'win32')).toBe(
      '//server/share/commonStyle.ts'
    );
    expect(toCacheKey('//server/share/commonStyle.ts', 'win32')).toBe(
      '//server/share/commonStyle.ts'
    );
    expect(toCacheKey('//?/D:/literal', 'linux')).toBe('//?/D:/literal');
    expect(toCacheKey('//server/share/commonStyle.ts', 'linux')).toBe(
      '//server/share/commonStyle.ts'
    );
  });

  it('normalizes extended Windows paths before using them in requests', () => {
    expect(toWebpackRequestPath('\\\\?\\D:\\work\\app\\commonStyle.ts')).toBe(
      'D:\\work\\app\\commonStyle.ts'
    );
    expect(
      toWebpackRequestPath('//?/D:/work/app/commonStyle.ts', 'win32')
    ).toBe('D:/work/app/commonStyle.ts');
    expect(
      toWebpackRequestPath('\\\\?\\UNC\\server\\share\\commonStyle.ts')
    ).toBe('\\\\server\\share\\commonStyle.ts');
    expect(
      toWebpackRequestPath('//?/UNC/server/share/commonStyle.ts', 'win32')
    ).toBe('\\\\server\\share\\commonStyle.ts');
    expect(toWebpackRequestPath('\\\\server\\share\\commonStyle.ts')).toBe(
      '\\\\server\\share\\commonStyle.ts'
    );
    expect(toWebpackRequestPath('//server/share/commonStyle.ts', 'win32')).toBe(
      '\\\\server\\share\\commonStyle.ts'
    );
    expect(toWebpackRequestPath('//server/share/commonStyle.ts', 'linux')).toBe(
      '//server/share/commonStyle.ts'
    );
    expect(toWebpackRequestPath('//?/D:/literal', 'linux')).toBe(
      '//?/D:/literal'
    );
  });

  it('rejects extended Windows paths that cannot be safely denamespaced', () => {
    expect(() =>
      toWebpackRequestPath('\\\\?\\Volume{1234}\\work\\entry.ts')
    ).toThrow('Unsupported Windows extended path namespace');
    expect(() =>
      toWebpackRequestPath('\\\\?\\D:\\work\\trailing.\\entry.ts')
    ).toThrow('Unsupported Windows extended path with trailing dot or space');
    expect(() =>
      toCacheKey('\\\\?\\UNC\\server\\share\\trailing \\entry.ts')
    ).toThrow('Unsupported Windows extended path with trailing dot or space');
  });

  it('preserves backslashes in POSIX paths', () => {
    const posixPath = '/work/app/common\\Style.ts';

    expect(toCacheKey(posixPath)).toBe(posixPath);
    expect(toWebpackRequestPath(posixPath)).toBe(posixPath);
  });

  it('reads CSS written with a different Windows path representation', async () => {
    const cssText = '.title{color:red}';

    await memoryCache.set('D:\\work\\app\\commonStyle.ts', cssText);

    expect(await memoryCache.get('D:/work/app/commonStyle.ts')).toBe(cssText);
    expect(await memoryCache.get('d:\\work\\app\\commonStyle.ts')).toBe(
      cssText
    );
  });

  it('scopes registered cache providers to their compiler', async () => {
    const firstCompiler = {};
    const secondCompiler = {};
    const cacheProviderToken = 'provider-a';

    registerCacheProvider(memoryCache, cacheProviderToken, firstCompiler);

    expect(
      await getCacheInstance(undefined, firstCompiler, cacheProviderToken)
    ).toBe(memoryCache);
    expect(
      await getCacheInstance(undefined, secondCompiler, cacheProviderToken)
    ).not.toBe(memoryCache);

    clearCacheProviderRegistry(firstCompiler);
    expect(
      await getCacheInstance(undefined, firstCompiler, cacheProviderToken)
    ).not.toBe(memoryCache);
  });

  it('round-trips the fallback CSS payload', () => {
    const payload = {
      cssText: '.title{color:red}'.repeat(100),
    };
    const encodedPayload = encodeOutputCssPayload(payload);

    expect(decodeOutputCssPayload(encodedPayload)).toEqual(payload);
    expect(encodedPayload.length).toBeLessThan(payload.cssText.length);
    expect(() => decodeOutputCssPayload('not-versioned')).toThrow(
      'Invalid output CSS payload'
    );
    expect(() => decodeOutputCssPayload('v1.not-compressed')).toThrow(
      'Invalid output CSS payload'
    );
  });
});
