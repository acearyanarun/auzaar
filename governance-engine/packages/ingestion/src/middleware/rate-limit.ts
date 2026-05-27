import type { IncomingMessage } from "node:http";

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  /**
   * SEC-9: When true, the rate limiter identifies clients by the first IP in
   * the X-Forwarded-For header instead of `req.socket.remoteAddress`.
   * Enable this when the proxy runs behind a trusted load balancer or ingress
   * that sets X-Forwarded-For.  Do NOT enable if untrusted clients can set
   * this header themselves.
   */
  trustProxy?: boolean;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(private readonly config: RateLimitConfig) {}

  check(key: string): { allowed: boolean; remaining: number; resetMs: number } {
    const now = Date.now();
    const entry = this.entries.get(key);

    if (!entry || now - entry.windowStart >= this.config.windowMs) {
      this.entries.set(key, { count: 1, windowStart: now });
      return {
        allowed: true,
        remaining: this.config.maxRequests - 1,
        resetMs: this.config.windowMs,
      };
    }

    if (entry.count >= this.config.maxRequests) {
      const resetMs = this.config.windowMs - (now - entry.windowStart);
      return { allowed: false, remaining: 0, resetMs };
    }

    entry.count++;
    const resetMs = this.config.windowMs - (now - entry.windowStart);
    return {
      allowed: true,
      remaining: this.config.maxRequests - entry.count,
      resetMs,
    };
  }

  reset(key: string): void {
    this.entries.delete(key);
  }
}

/**
 * SEC-9: Extracts the client IP from a request, respecting X-Forwarded-For
 * when `trustProxy` is true.
 *
 * X-Forwarded-For format: "client, proxy1, proxy2"
 * We take only the first (leftmost) address, which is the originating client
 * IP as set by the first trusted proxy.
 */
export function extractClientIp(
  req: IncomingMessage,
  trustProxy?: boolean
): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      const firstIp = forwarded.split(",")[0]?.trim();
      if (firstIp) return firstIp;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}
