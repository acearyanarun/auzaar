import { describe, it, expect } from "vitest";
import { authenticate } from "../middleware/auth.js";
import { BoundedMap } from "../context.js";
import { RateLimiter, extractClientIp } from "../middleware/rate-limit.js";
import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";

describe("authenticate", () => {
  it("passes with mode none", () => {
    const result = authenticate(undefined, { mode: "none" });
    expect(result.authenticated).toBe(true);
  });

  it("fails without auth header in bearer mode", () => {
    const result = authenticate(undefined, { mode: "bearer" });
    expect(result.authenticated).toBe(false);
    // SEC-12: public error must be generic; specific reason goes to internalReason
    expect(result.error).toBe("Unauthorized");
    expect(result.internalReason).toContain("Missing");
  });

  it("fails with invalid bearer format", () => {
    const result = authenticate("Basic abc", { mode: "bearer" });
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe("Unauthorized");
    expect(result.internalReason).toContain("Invalid bearer");
  });

  it("succeeds with valid bearer token", () => {
    const keys = new Map([["test-token", { agentId: "agt_1", userId: "usr_1" }]]);
    const result = authenticate("Bearer test-token", {
      mode: "bearer",
      apiKeys: keys,
    });
    expect(result.authenticated).toBe(true);
    expect(result.agentId).toBe("agt_1");
    expect(result.userId).toBe("usr_1");
  });

  it("fails with unknown bearer token", () => {
    const keys = new Map([["real-token", { agentId: "agt_1", userId: "usr_1" }]]);
    const result = authenticate("Bearer fake-token", {
      mode: "bearer",
      apiKeys: keys,
    });
    expect(result.authenticated).toBe(false);
  });

  it("succeeds with valid api-key", () => {
    const keys = new Map([["my-key", { agentId: "agt_1", userId: "usr_1" }]]);
    const result = authenticate("my-key", { mode: "api-key", apiKeys: keys });
    expect(result.authenticated).toBe(true);
  });
});

describe("RateLimiter", () => {
  it("allows requests within limit", () => {
    const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 5 });
    for (let i = 0; i < 5; i++) {
      const result = limiter.check("client_1");
      expect(result.allowed).toBe(true);
    }
  });

  it("blocks requests over limit", () => {
    const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 3 });
    limiter.check("client_1");
    limiter.check("client_1");
    limiter.check("client_1");
    const result = limiter.check("client_1");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("tracks remaining requests", () => {
    const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 5 });
    expect(limiter.check("client_1").remaining).toBe(4);
    expect(limiter.check("client_1").remaining).toBe(3);
  });

  it("tracks different clients independently", () => {
    const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 2 });
    limiter.check("client_1");
    limiter.check("client_1");
    expect(limiter.check("client_1").allowed).toBe(false);
    expect(limiter.check("client_2").allowed).toBe(true);
  });

  it("resets after window", () => {
    const limiter = new RateLimiter({ windowMs: 1, maxRequests: 1 });
    limiter.check("client_1");

    // Reset manually
    limiter.reset("client_1");
    expect(limiter.check("client_1").allowed).toBe(true);
  });
});

// =============================================================================
// SEC-9: extractClientIp — X-Forwarded-For support
// =============================================================================

/** Creates a minimal IncomingMessage-like object for testing. */
function makeReq(opts: {
  remoteAddress?: string;
  forwardedFor?: string;
}): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    get: () => opts.remoteAddress, // may be undefined — caller controls this
  });
  const req = Object.create(null) as IncomingMessage;
  req.socket = socket;
  req.headers = opts.forwardedFor
    ? { "x-forwarded-for": opts.forwardedFor }
    : {};
  return req;
}

describe("extractClientIp (SEC-9)", () => {
  it("returns socket remoteAddress when trustProxy is false", () => {
    const req = makeReq({ remoteAddress: "10.0.0.1", forwardedFor: "203.0.113.5" });
    expect(extractClientIp(req, false)).toBe("10.0.0.1");
  });

  it("returns socket remoteAddress when trustProxy is undefined (default)", () => {
    const req = makeReq({ remoteAddress: "10.0.0.1", forwardedFor: "203.0.113.5" });
    expect(extractClientIp(req, undefined)).toBe("10.0.0.1");
  });

  it("returns the X-Forwarded-For IP when trustProxy is true", () => {
    const req = makeReq({ remoteAddress: "10.0.0.1", forwardedFor: "203.0.113.5" });
    expect(extractClientIp(req, true)).toBe("203.0.113.5");
  });

  it("takes only the first (client) IP from a multi-hop X-Forwarded-For list", () => {
    const req = makeReq({
      remoteAddress: "10.0.0.1",
      forwardedFor: "203.0.113.5, 10.0.0.2, 10.0.0.3",
    });
    expect(extractClientIp(req, true)).toBe("203.0.113.5");
  });

  it("trims whitespace from the extracted IP", () => {
    const req = makeReq({ remoteAddress: "10.0.0.1", forwardedFor: "  203.0.113.5  " });
    expect(extractClientIp(req, true)).toBe("203.0.113.5");
  });

  it("falls back to socket address when X-Forwarded-For is empty", () => {
    const req = makeReq({ remoteAddress: "10.0.0.1", forwardedFor: "" });
    expect(extractClientIp(req, true)).toBe("10.0.0.1");
  });

  it("falls back to socket address when X-Forwarded-For is only whitespace", () => {
    const req = makeReq({ remoteAddress: "10.0.0.1", forwardedFor: "   " });
    expect(extractClientIp(req, true)).toBe("10.0.0.1");
  });

  it("returns 'unknown' when there is no remoteAddress and no X-Forwarded-For", () => {
    const req = makeReq({ remoteAddress: undefined });
    expect(extractClientIp(req, false)).toBe("unknown");
  });
});

// =============================================================================
// SEC-19: BoundedMap — LRU eviction at max capacity
// =============================================================================

describe("BoundedMap (SEC-19)", () => {
  it("stores entries up to the capacity limit", () => {
    const map = new BoundedMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    expect(map.size).toBe(3);
    expect(map.get("a")).toBe(1);
  });

  it("evicts the oldest (LRU) entry when capacity is exceeded", () => {
    const map = new BoundedMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    // Insert a 4th entry — "a" should be evicted (oldest)
    map.set("d", 4);
    expect(map.size).toBe(3);
    expect(map.has("a")).toBe(false);
    expect(map.get("d")).toBe(4);
  });

  it("moves a re-set key to most-recently-used position", () => {
    const map = new BoundedMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    // Re-set "a" — moves it to end (most-recently-used)
    map.set("a", 99);
    // Insert a 4th entry — "b" should be evicted now (oldest)
    map.set("d", 4);
    expect(map.has("b")).toBe(false);
    expect(map.get("a")).toBe(99);
    expect(map.get("d")).toBe(4);
  });

  it("defaults to 10,000 entry limit", () => {
    const map = new BoundedMap<number, number>();
    for (let i = 0; i < 10_001; i++) {
      map.set(i, i);
    }
    expect(map.size).toBe(10_000);
    // Key 0 should have been evicted
    expect(map.has(0)).toBe(false);
    expect(map.has(10_000)).toBe(true);
  });
});

// =============================================================================
// SEC-8: ApiProxy warns when auth mode is "none"
// =============================================================================
import { vi } from "vitest";
import { ApiProxy } from "../api-proxy.js";

describe("ApiProxy auth-none warning (SEC-8)", () => {
  it("emits a console.warn when constructed with auth mode 'none'", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Minimal context — we only need the constructor to run
    const minimalCtx = {
      mandateService: {} as never,
      governanceEngine: {} as never,
      decisions: new Map(),
      requests: new Map(),
    };

    new ApiProxy(minimalCtx, { auth: { mode: "none" } });

    // At least one warn call must mention the auth mode
    const warnedAboutAuth = warnSpy.mock.calls.some(
      (args) => typeof args[0] === "string" && args[0].includes("none")
    );
    expect(warnedAboutAuth).toBe(true);
    warnSpy.mockRestore();
  });

  it("does not warn when constructed with a real auth mode", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const minimalCtx = {
      mandateService: {} as never,
      governanceEngine: {} as never,
      decisions: new Map(),
      requests: new Map(),
    };

    new ApiProxy(minimalCtx, {
      auth: {
        mode: "bearer",
        apiKeys: new Map([["tok", { agentId: "agt_1", userId: "usr_1" }]]),
      },
    });

    // No auth-mode warning should fire for a configured mode
    const authWarnings = warnSpy.mock.calls.filter((args) =>
      typeof args[0] === "string" && args[0].includes("auth mode is 'none'")
    );
    expect(authWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });
});
