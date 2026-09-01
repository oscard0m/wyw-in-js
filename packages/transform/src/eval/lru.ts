export class LruCache<K, V> {
  private readonly maxSize: number;

  private readonly map = new Map<K, V>();

  constructor(maxSize: number) {
    this.maxSize = Math.max(1, maxSize);
  }

  public get size(): number {
    return this.map.size;
  }

  public peek(key: K): V | undefined {
    return this.map.get(key);
  }

  public get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;

    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  public set(
    key: K,
    value: V,
    onEvict?: (evictedKey: K, evictedValue: V) => void
  ): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }

    this.map.set(key, value);

    if (this.map.size > this.maxSize) {
      const firstKey = this.map.keys().next().value as K | undefined;
      if (firstKey !== undefined) {
        const evictedValue = this.map.get(firstKey)!;
        this.map.delete(firstKey);
        onEvict?.(firstKey, evictedValue);
      }
    }
  }

  public has(key: K): boolean {
    return this.map.has(key);
  }

  public delete(key: K): void {
    this.map.delete(key);
  }

  public clear(): void {
    this.map.clear();
  }
}
