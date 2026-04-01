import type { Context, Next } from 'hono';

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

interface WindowEntry {
  timestamps: number[];
}

export class RateLimiter {
  private windows: Map<string, WindowEntry> = new Map();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: RateLimitConfig) {
    this.windowMs = config.windowMs;
    this.maxRequests = config.maxRequests;

    // Clean up stale entries every 60 seconds
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    // Allow the process to exit without waiting for cleanup
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Check if the request is allowed and record it.
   * Returns the number of remaining requests, or -1 if rate limited.
   */
  check(key: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let entry = this.windows.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.windows.set(key, entry);
    }

    // Remove timestamps outside the sliding window
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    if (entry.timestamps.length >= this.maxRequests) {
      // Calculate when the earliest request in the window will expire
      const oldestInWindow = entry.timestamps[0];
      const retryAfterMs = oldestInWindow + this.windowMs - now;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(retryAfterMs, 1000),
      };
    }

    entry.timestamps.push(now);
    return {
      allowed: true,
      remaining: this.maxRequests - entry.timestamps.length,
      retryAfterMs: 0,
    };
  }

  /** Remove entries that have no timestamps within the current window. */
  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    for (const [key, entry] of this.windows) {
      entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
      if (entry.timestamps.length === 0) {
        this.windows.delete(key);
      }
    }
  }

  /** Stop the cleanup timer. */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

/**
 * Extract a client identifier from the request for rate limiting.
 * Uses X-Forwarded-For, X-Real-IP, or falls back to a default key.
 */
function getClientKey(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  const realIp = c.req.header('x-real-ip');
  if (realIp) {
    return realIp;
  }

  // Fallback — in production behind a reverse proxy, one of the above
  // headers should always be present.
  return 'unknown';
}

/**
 * Hono middleware factory that applies rate limiting per client IP.
 */
export function rateLimitMiddleware(config: RateLimitConfig): (c: Context, next: Next) => Promise<Response | void> {
  const limiter = new RateLimiter(config);

  return async (c: Context, next: Next) => {
    const key = getClientKey(c);
    const result = limiter.check(key);

    // Always set informational headers
    c.header('X-RateLimit-Limit', String(config.maxRequests));
    c.header('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
      c.header('Retry-After', String(retryAfterSeconds));
      return c.json(
        {
          error: 'Too many requests',
          retry_after_seconds: retryAfterSeconds,
        },
        429,
      );
    }

    await next();
  };
}
