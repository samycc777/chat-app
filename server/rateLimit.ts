import type { NextFunction, Request, Response } from 'express';

export interface Limiter {
  /** Counts one request for the key and reports whether it is still within the limit. */
  hit(key: string): { allowed: boolean; retryAfterSeconds: number };
  /** Reports whether the key has used its whole allowance, without counting a request. */
  exhausted(key: string): { exhausted: boolean; retryAfterSeconds: number };
}

export function createLimiter(limit: number, windowMs: number): Limiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let nextSweep = 0;

  function current(key: string, now: number) {
    if (now >= nextSweep) {
      for (const [bucketKey, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(bucketKey);
      nextSweep = now + windowMs;
    }
    const bucket = buckets.get(key);
    return bucket && bucket.resetAt > now ? bucket : undefined;
  }

  return {
    hit(key) {
      const now = Date.now();
      let bucket = current(key, now);
      if (!bucket) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count++;
      return { allowed: bucket.count <= limit, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
    },
    exhausted(key) {
      const now = Date.now();
      const bucket = current(key, now);
      return bucket && bucket.count >= limit
        ? { exhausted: true, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) }
        : { exhausted: false, retryAfterSeconds: 0 };
    },
  };
}

export function rateLimit<R extends Request>(limit: number, windowMs: number, keyOf: (req: R) => string = req => req.ip || 'unknown') {
  const limiter = createLimiter(limit, windowMs);
  return (req: R, res: Response, next: NextFunction) => {
    const { allowed, retryAfterSeconds } = limiter.hit(keyOf(req));
    if (allowed) return next();
    res.setHeader('Retry-After', retryAfterSeconds);
    res.status(429).json({ error: 'Too many requests' });
  };
}
