export interface TtlCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  readonly size: number;
}

export interface CacheOptions {
  ttlSeconds: number;
  maxEntries: number;
  now?: () => number;
}

/**
 * Per-process, bounded, and correct when cold (12-factor VI). Deliberately a Map and not a
 * backing service: a shared cache would hide the CACHE_TTL_SECONDS fault behind another tier.
 */
export function createCache<T>(opts: CacheOptions): TtlCache<T> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlSeconds * 1000;
  const entries = new Map<string, { value: T; expiresAt: number }>();

  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },

    set(key, value) {
      if (ttlMs === 0) return;
      // Map iterates in insertion order, so the first key is the oldest.
      entries.delete(key);
      if (entries.size >= opts.maxEntries) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },

    get size() {
      return entries.size;
    },
  };
}
