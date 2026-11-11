import { createHash } from 'node:crypto';
import { AppError } from './error-handler.js';

function createRateLimiter({ limit, windowMs, key }) {
  const buckets = new Map();
  let requestsSinceCleanup = 0;

  return function rateLimit(req, res, next) {
    const now = Date.now();
    requestsSinceCleanup += 1;
    if (requestsSinceCleanup >= 256) {
      requestsSinceCleanup = 0;
      for (const [storedKey, stored] of buckets) {
        if (stored.resetAt <= now) {
          buckets.delete(storedKey);
        }
      }
    }

    const bucketKey = key(req);
    let bucket = buckets.get(bucketKey);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, bucket);
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later.'));
    }

    if (buckets.size > 10_000) {
      for (const [storedKey, stored] of buckets) {
        if (stored.resetAt <= now) {
          buckets.delete(storedKey);
        }
      }
      if (buckets.size > 10_000) {
        buckets.delete(buckets.keys().next().value);
      }
    }
    return next();
  };
}

function accountRateLimitKey(email) {
  return createHash('sha256').update(email).digest('hex');
}

export { accountRateLimitKey, createRateLimiter };
