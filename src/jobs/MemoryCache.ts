export class MemoryCache<T> {
  private readonly cache = new Map<string, T>();

  constructor(private readonly createFn: () => T) {}

  get(key: string): T {
    let value = this.cache.get(key);
    if (!value) {
      value = this.createFn();
      this.cache.set(key, value);
    }
    return value;
  }
}
