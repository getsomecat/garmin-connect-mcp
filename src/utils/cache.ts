interface CacheEntry<T> {
  value: T
  expiresAt: number
}

/** A bounded, in-memory TTL/LRU cache with in-flight request de-duplication. */
export class MemoryCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>()
  private readonly pending = new Map<string, Promise<unknown>>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 100,
  ) {}

  async getOrSet<T>(key: string, factory: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return factory()

    const cached = this.entries.get(key) as CacheEntry<T> | undefined
    if (cached && cached.expiresAt > Date.now()) {
      this.touch(key, cached)
      return cached.value
    }
    if (cached) this.entries.delete(key)

    const inFlight = this.pending.get(key) as Promise<T> | undefined
    if (inFlight) return inFlight

    const request = factory()
      .then((value) => {
        this.set(key, value)
        return value
      })
      .finally(() => {
        this.pending.delete(key)
      })

    this.pending.set(key, request)
    return request
  }

  clear(): void {
    this.entries.clear()
    this.pending.clear()
  }

  private set<T>(key: string, value: T): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  private touch<T>(key: string, entry: CacheEntry<T>): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
  }
}
