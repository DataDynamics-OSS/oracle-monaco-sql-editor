/**
 * TTL cache with in-flight de-duplication (extracted from trino-monaco's
 * metadata provider). Identical concurrent lookups share one request; a
 * request whose caller aborted is never handed to a later caller.
 */

export interface QueryCache {
  /** Cached value for `key`, or the result of `load` (shared while in flight). */
  get<T>(key: string, load: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T>;
  /** Drop every cached value (e.g. after DDL). */
  clear(): void;
}

export function createQueryCache(ttlMs: number): QueryCache {
  const values = new Map<string, { expiry: number; value: unknown }>();
  const inflight = new Map<string, { promise: Promise<unknown>; signal: AbortSignal }>();

  return {
    get<T>(key: string, load: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
      const cached = values.get(key);
      if (cached && cached.expiry > Date.now()) return Promise.resolve(cached.value as T);

      const running = inflight.get(key);
      if (running && !running.signal.aborted) return running.promise as Promise<T>;

      const promise = load(signal)
        .then((value) => {
          if (ttlMs > 0) values.set(key, { expiry: Date.now() + ttlMs, value });
          return value;
        })
        .finally(() => {
          if (inflight.get(key)?.promise === promise) inflight.delete(key);
        });
      inflight.set(key, { promise, signal });
      return promise;
    },

    clear() {
      values.clear();
      inflight.clear();
    },
  };
}
