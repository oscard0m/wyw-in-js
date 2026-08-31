import type webpack from 'webpack';

import type { ICache } from './cache';
import { getCacheInstance, toCacheKey } from './cache';

export default async function outputCssLoader(
  this: webpack.LoaderContext<{
    cacheProvider: string | ICache | undefined;
    cacheProviderId?: string | undefined;
  }>
) {
  this.async();
  const { cacheProvider, cacheProviderId } = this.getOptions();

  try {
    const cacheInstance = await getCacheInstance(
      cacheProvider,
      cacheProviderId
    );

    const cacheKey = toCacheKey(this.resourcePath);
    const result = await cacheInstance.get(cacheKey);
    const dependencies =
      (await cacheInstance.getDependencies?.(cacheKey)) ?? [];

    dependencies.forEach((dependency) => {
      this.addDependency(dependency);
    });

    this.callback(null, result);
  } catch (err) {
    this.callback(err as Error);
  }
}
