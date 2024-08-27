export class MemoryCache<T> {
  private readonly cache = new Map<string, T>();

  constructor(private readonly createFn: () => T) {}

  get(key: string): T {
    if (!this.cache.has(key)) {
      this.cache.set(key, this.createFn());
    }
    return this.cache.get(key)!;
  }
}
