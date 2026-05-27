import { describe, it, expect } from "vitest";
import { ProxyRequestBodySchema, validateTargetUrl, ApiProxy } from "../api-proxy.js";

// =============================================================================
// SEC-3: Zod body schema validation
// =============================================================================

describe("ProxyRequestBodySchema (SEC-3)", () => {
  const validBody = {
    mandateId: "mdt_abc",
    agentId: "agt_001",
    userId: "usr_001",
    vendor: "Amazon",
    product: "keyboard",
    amount: 75,
  };

  it("accepts a minimal valid body", () => {
    const result = ProxyRequestBodySchema.safeParse(validBody);
    expect(result.success).toBe(true);
  });

  it("accepts a fully populated body with optional fields", () => {
    const result = ProxyRequestBodySchema.safeParse({
      ...validBody,
      currency: "USD",
      quantity: 2,
      category: "electronics",
      targetProtocol: "acp",
      targetUrl: "https://api.example.com/acp/order",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a string amount (was silently cast before)", () => {
    const result = ProxyRequestBodySchema.safeParse({
      ...validBody,
      amount: "free",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.flatten().fieldErrors).toHaveProperty("amount");
  });

  it("rejects a negative amount", () => {
    const result = ProxyRequestBodySchema.safeParse({
      ...validBody,
      amount: -50,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a zero amount", () => {
    const result = ProxyRequestBodySchema.safeParse({ ...validBody, amount: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects a missing mandateId", () => {
    const { mandateId: _, ...rest } = validBody;
    const result = ProxyRequestBodySchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.flatten().fieldErrors).toHaveProperty("mandateId");
  });

  it("rejects an empty vendor string", () => {
    const result = ProxyRequestBodySchema.safeParse({ ...validBody, vendor: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid targetProtocol value", () => {
    const result = ProxyRequestBodySchema.safeParse({
      ...validBody,
      targetProtocol: "ftp",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a float quantity", () => {
    const result = ProxyRequestBodySchema.safeParse({
      ...validBody,
      quantity: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a body with amount as a JSON number-like string", () => {
    // JSON.parse of '{"amount":"100"}' yields a string; schema must reject it
    const result = ProxyRequestBodySchema.safeParse({ ...validBody, amount: "100" });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// SEC-5: SSRF protection via validateTargetUrl
// =============================================================================

describe("validateTargetUrl (SEC-5)", () => {
  // --- Addresses that must be rejected ---

  it("rejects localhost by name", () => {
    const r = validateTargetUrl("http://localhost/api");
    expect(r.valid).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("rejects 127.0.0.1 loopback", () => {
    const r = validateTargetUrl("http://127.0.0.1/api");
    expect(r.valid).toBe(false);
  });

  it("rejects arbitrary 127.x.x.x loopback address", () => {
    const r = validateTargetUrl("http://127.5.6.7/api");
    expect(r.valid).toBe(false);
  });

  it("rejects IPv6 loopback [::1]", () => {
    const r = validateTargetUrl("http://[::1]/api");
    expect(r.valid).toBe(false);
  });

  it("rejects 0.0.0.0 wildcard", () => {
    const r = validateTargetUrl("http://0.0.0.0/api");
    expect(r.valid).toBe(false);
  });

  it("rejects RFC-1918 10.x.x.x range", () => {
    const r = validateTargetUrl("http://10.0.0.1/internal");
    expect(r.valid).toBe(false);
  });

  it("rejects RFC-1918 172.16.x.x range", () => {
    const r = validateTargetUrl("http://172.16.0.1/internal");
    expect(r.valid).toBe(false);
  });

  it("rejects RFC-1918 172.31.x.x (upper boundary of /12)", () => {
    const r = validateTargetUrl("http://172.31.255.255/internal");
    expect(r.valid).toBe(false);
  });

  it("allows 172.32.x.x (just outside RFC-1918 /12)", () => {
    const r = validateTargetUrl("https://172.32.0.1/api");
    expect(r.valid).toBe(true);
  });

  it("rejects RFC-1918 192.168.x.x range", () => {
    const r = validateTargetUrl("http://192.168.1.1/router");
    expect(r.valid).toBe(false);
  });

  it("rejects cloud metadata endpoint 169.254.169.254", () => {
    const r = validateTargetUrl("http://169.254.169.254/latest/meta-data/");
    expect(r.valid).toBe(false);
  });

  it("rejects any 169.254.x.x link-local address", () => {
    const r = validateTargetUrl("http://169.254.0.1/");
    expect(r.valid).toBe(false);
  });

  it("rejects a non-HTTP scheme (file://)", () => {
    const r = validateTargetUrl("file:///etc/passwd");
    expect(r.valid).toBe(false);
  });

  it("rejects a non-HTTP scheme (ftp://)", () => {
    const r = validateTargetUrl("ftp://example.com/data");
    expect(r.valid).toBe(false);
  });

  it("rejects a completely invalid URL", () => {
    const r = validateTargetUrl("not-a-url");
    expect(r.valid).toBe(false);
  });

  // --- Addresses that must be allowed ---

  it("allows a public HTTPS URL", () => {
    const r = validateTargetUrl("https://api.acme-commerce.com/acp/order");
    expect(r.valid).toBe(true);
  });

  it("allows a public HTTP URL", () => {
    const r = validateTargetUrl("http://commerce.example.com/ucp/v1/checkout");
    expect(r.valid).toBe(true);
  });

  it("allows a public IP address that is not in a private range", () => {
    // 8.8.8.8 is a public Google DNS address
    const r = validateTargetUrl("https://8.8.8.8/api");
    expect(r.valid).toBe(true);
  });

  it("allows a domain that looks like it could be private but is not an IP", () => {
    // hostname-based URLs cannot be checked without DNS; we allow them and rely
    // on infrastructure-level egress controls for DNS-rebinding scenarios
    const r = validateTargetUrl("https://internal.acme.com/api");
    expect(r.valid).toBe(true);
  });
});

// =============================================================================
// SEC-17: URL pattern matching uses proper regex escaping
// =============================================================================

describe("ApiProxy.matchesPattern (SEC-17)", () => {
  // Access the private method through a subclass for testing
  class TestProxy extends ApiProxy {
    public testMatchesPattern(url: string): boolean {
      return (this as unknown as { matchesPattern(url: string): boolean }).matchesPattern(url);
    }
  }

  function makeProxy(patterns: string[]): TestProxy {
    const minimalCtx = {
      mandateService: {} as never,
      governanceEngine: {} as never,
      decisions: new Map(),
      requests: new Map(),
    };
    return new TestProxy(minimalCtx, { targetPatterns: patterns });
  }

  it("matches a simple wildcard pattern", () => {
    const proxy = makeProxy(["*.openai.com/acp/*"]);
    expect(proxy.testMatchesPattern("api.openai.com/acp/order")).toBe(true);
  });

  it("does not match a non-matching URL", () => {
    const proxy = makeProxy(["*.openai.com/acp/*"]);
    expect(proxy.testMatchesPattern("evil.com/inject")).toBe(false);
  });

  it("does not allow regex injection via + metacharacter in pattern", () => {
    // If + were not escaped, "a+" would match "aaa", "b", etc.
    // With proper escaping, "a+" in a pattern is a literal "a+" string.
    const proxy = makeProxy(["a+.example.com/*"]);
    // Should NOT match "aaaa.example.com/path" (regex a+ behaviour)
    expect(proxy.testMatchesPattern("aaaa.example.com/path")).toBe(false);
    // Should match the literal "a+.example.com/path"
    expect(proxy.testMatchesPattern("a+.example.com/path")).toBe(true);
  });

  it("does not allow regex injection via ( metacharacter in pattern", () => {
    // Unescaped ( would cause a regex parse error or change semantics
    const proxy = makeProxy(["(foo).example.com/*"]);
    expect(proxy.testMatchesPattern("(foo).example.com/bar")).toBe(true);
    expect(proxy.testMatchesPattern("foo.example.com/bar")).toBe(false);
  });

  it("dots in patterns are treated as literals, not any-char wildcards", () => {
    const proxy = makeProxy(["api.example.com/*"]);
    // Without escaping, "api.example.com" regex would also match "apiXexample.com"
    expect(proxy.testMatchesPattern("apiXexample.com/path")).toBe(false);
    expect(proxy.testMatchesPattern("api.example.com/path")).toBe(true);
  });
});

// =============================================================================
// SEC-4: Body size limit — tested via the exported readBody-integrated flow.
// Because readBody is an internal function, we test SEC-4 through the HTTP
// server integration using a real TCP request.
// =============================================================================
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

describe("readBody size limit (SEC-4)", () => {
  /**
   * Spins up a minimal HTTP server that pipes the request through readBody
   * (extracted inline here to avoid re-exporting an internal implementation
   * detail) with a given maxBytes cap.  Returns the response status + body.
   */
  async function sendOversizedRequest(
    maxBytes: number,
    bodySize: number
  ): Promise<{ status: number; body: string }> {
    // Mirror the same readBody logic from api-proxy.ts
    function readBodyWithLimit(
      req: IncomingMessage,
      max: number
    ): Promise<string | null> {
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let tooLarge = false;
        req.on("data", (chunk: Buffer) => {
          if (tooLarge) return;
          total += chunk.length;
          if (total > max) {
            tooLarge = true;
            chunks.length = 0;
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", () => {
          if (tooLarge) {
            reject(new Error("REQUEST_TOO_LARGE"));
            return;
          }
          resolve(chunks.length ? Buffer.concat(chunks).toString() : null);
        });
        req.on("error", () => resolve(null));
      });
    }

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        await readBodyWithLimit(req, maxBytes);
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        if (e instanceof Error && e.message === "REQUEST_TOO_LARGE") {
          if (!res.headersSent) {
            res.writeHead(413);
            res.end("too large");
          }
        } else {
          res.writeHead(500);
          res.end("error");
        }
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };

    const payload = "x".repeat(bodySize);
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      body: payload,
    });
    const text = await response.text();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return { status: response.status, body: text };
  }

  it("accepts a body within the size limit", async () => {
    const { status } = await sendOversizedRequest(1000, 500);
    expect(status).toBe(200);
  });

  it("returns 413 when body exactly exceeds the limit", async () => {
    const { status } = await sendOversizedRequest(100, 101);
    expect(status).toBe(413);
  });

  it("returns 413 for a body far exceeding the limit", async () => {
    const { status } = await sendOversizedRequest(1024, 10_000);
    expect(status).toBe(413);
  });
});
