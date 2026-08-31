describe('webpack-loader cache module graphs', () => {
  it('shares cache providers across independently evaluated module graphs', async () => {
    const firstModule = '../cache.ts?graph=first';
    const secondModule = '../cache.ts?graph=second';
    const first = await import(firstModule);
    const second = await import(secondModule);

    expect(first.registerCacheProvider).not.toBe(second.registerCacheProvider);
    expect(first.memoryCache).not.toBe(second.memoryCache);

    const compiler = {};
    const cacheProviderToken = 'provider-a';
    first.registerCacheProvider(
      first.memoryCache,
      cacheProviderToken,
      compiler
    );

    expect(
      await second.getCacheInstance(undefined, compiler, cacheProviderToken)
    ).toBe(first.memoryCache);

    second.clearCacheProviderRegistry(compiler);
    expect(
      await first.getCacheInstance(undefined, compiler, cacheProviderToken)
    ).not.toBe(first.memoryCache);
  });
});
