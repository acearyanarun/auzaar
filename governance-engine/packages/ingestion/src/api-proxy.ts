import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import type { AuzaarContext } from "./context.js";
import { authenticate, type AuthConfig } from "./middleware/auth.js";
import { RateLimiter, type RateLimitConfig, extractClientIp } from "./middleware/rate-limit.js";
import { RequestRouter } from "./router.js";

// ---------------------------------------------------------------------------
// SEC-3: Zod schema for inbound proxy request bodies.
// All fields are validated before being passed to the governance router,
// replacing the previous pattern of unsafe `as` type casts.
// ---------------------------------------------------------------------------
export const ProxyRequestBodySchema = z.object({
  mandateId: z.string().min(1),
  agentId: z.string().min(1),
  userId: z.string().min(1),
  vendor: z.string().min(1),
  product: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().optional(),
  quantity: z.number().int().positive().optional(),
  category: z.string().optional(),
  targetProtocol: z.enum(["acp", "ucp", "ap2", "direct"]).optional(),
  targetUrl: z.string().optional(),
});

export type ProxyRequestBody = z.infer<typeof ProxyRequestBodySchema>;

// ---------------------------------------------------------------------------
// SEC-5: SSRF protection — reject targetUrls that resolve to private,
// loopback, link-local, or cloud-metadata addresses.
//
// Note: this check operates on the literal hostname in the URL.  It does NOT
// perform DNS resolution, so a domain that resolves to a private IP at runtime
// would not be caught here.  For defence-in-depth, outbound network egress
// should also be restricted at the infrastructure level.
// ---------------------------------------------------------------------------

/** Returns true if `hostname` is a known-private or reserved address. */
function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();

  // Named loopback / wildcard
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;

  // Strip IPv6 brackets, e.g. [::1] → ::1
  const stripped = h.startsWith("[") ? h.slice(1, -1) : h;
  if (stripped === "::1") return true;

  // Parse as IPv4 dotted-decimal
  const parts = stripped.split(".").map(Number);
  if (
    parts.length === 4 &&
    parts.every((p) => Number.isFinite(p) && p >= 0 && p <= 255)
  ) {
    const [a, b] = parts as [number, number, number, number];
    return (
      a === 127 ||                          // 127.0.0.0/8   loopback
      a === 10 ||                           // 10.0.0.0/8    RFC-1918
      (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12 RFC-1918
      (a === 192 && b === 168) ||           // 192.168.0.0/16 RFC-1918
      (a === 169 && b === 254)              // 169.254.0.0/16 link-local + cloud metadata
    );
  }

  return false;
}

export function validateTargetUrl(url: string): { valid: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: "Invalid URL format" };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { valid: false, reason: "Only HTTP and HTTPS target URLs are permitted" };
  }

  if (isPrivateHostname(parsed.hostname)) {
    return {
      valid: false,
      reason: "Target URL resolves to a private or reserved address",
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Proxy configuration
// ---------------------------------------------------------------------------

export interface ApiProxyConfig {
  port: number;
  targetPatterns: string[];
  auth: AuthConfig;
  rateLimit: RateLimitConfig;
  /** SEC-4: Maximum allowed request body size in bytes. Default: 1 MiB. */
  maxBodyBytes: number;
}

const DEFAULT_CONFIG: ApiProxyConfig = {
  port: 3102,
  targetPatterns: ["*.openai.com/acp/*", "*.ucp.dev/*"],
  auth: { mode: "none" },
  rateLimit: { windowMs: 60_000, maxRequests: 100 },
  maxBodyBytes: 1_048_576, // 1 MiB
};

/**
 * HTTP reverse proxy that intercepts outbound commerce requests,
 * routes them through governance, and forwards approved requests.
 */
export class ApiProxy {
  private server: ReturnType<typeof createServer> | null = null;
  private readonly config: ApiProxyConfig;
  private readonly rateLimiter: RateLimiter;
  private readonly router: RequestRouter;

  constructor(ctx: AuzaarContext, config?: Partial<ApiProxyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // SEC-8: Warn loudly when auth is disabled so misconfigured deployments are
    // caught at startup rather than discovered during an incident.
    if (this.config.auth.mode === "none") {
      console.warn(
        "[auzaar] WARNING: API proxy is running with auth mode 'none'. " +
        "All requests are accepted without authentication. " +
        "Set auth.mode to 'bearer' or 'api-key' before deploying to production."
      );
    }

    this.rateLimiter = new RateLimiter(this.config.rateLimit);
    this.router = new RequestRouter(ctx);
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch(() => {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        });
      });
      this.server.listen(this.config.port, () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // Auth check
    const authResult = authenticate(
      req.headers.authorization,
      this.config.auth
    );
    if (!authResult.authenticated) {
      // SEC-12: log the specific reason internally; only expose generic "Unauthorized" to callers
      if (authResult.internalReason) {
        console.warn(
          JSON.stringify({ level: "warn", event: "auth_failed", reason: authResult.internalReason })
        );
      }
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: authResult.error ?? "Unauthorized" }));
      return;
    }

    // Rate limit check — SEC-9: prefer agentId when auth resolves one, otherwise
    // derive IP respecting X-Forwarded-For when trustProxy is enabled.
    const clientKey =
      authResult.agentId ?? extractClientIp(req, this.config.rateLimit.trustProxy);
    const limitResult = this.rateLimiter.check(clientKey);
    res.setHeader("X-RateLimit-Remaining", String(limitResult.remaining));
    res.setHeader("X-RateLimit-Reset", String(limitResult.resetMs));

    if (!limitResult.allowed) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Rate limit exceeded" }));
      return;
    }

    // SEC-4: Read body with a hard size limit — reject oversized payloads before
    // any further processing to prevent memory exhaustion.
    let rawBody: string | null;
    try {
      rawBody = await readBody(req, this.config.maxBodyBytes);
    } catch (e) {
      if (e instanceof Error && e.message === "REQUEST_TOO_LARGE") {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Request body exceeds maximum allowed size" })
        );
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to read request body" }));
      return;
    }

    if (!rawBody) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request body is required" }));
      return;
    }

    // Parse JSON
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // SEC-3: Validate body shape and types with Zod — replaces the previous
    // pattern of blind `as` casts that allowed type confusion.
    const bodyResult = ProxyRequestBodySchema.safeParse(parsedJson);
    if (!bodyResult.success) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Invalid request body",
          details: bodyResult.error.flatten().fieldErrors,
        })
      );
      return;
    }

    const body = bodyResult.data;

    // Resolve targetUrl: body field takes precedence over raw request path
    const targetUrl = body.targetUrl ?? req.url;

    // Check whether this URL falls within the governed patterns
    if (!this.matchesPattern(targetUrl ?? "")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ passthrough: true, message: "Not a governed route" })
      );
      return;
    }

    // SEC-5: SSRF protection — validate targetUrl before it propagates to the
    // protocol-release layer where it could trigger outbound requests.
    if (targetUrl) {
      const ssrfCheck = validateTargetUrl(targetUrl);
      if (!ssrfCheck.valid) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Invalid target URL", reason: ssrfCheck.reason })
        );
        return;
      }
    }

    // Route through governance
    try {
      const result = await this.router.routeTransaction({
        mandateId: body.mandateId,
        agentId: authResult.agentId ?? body.agentId,
        userId: authResult.userId ?? body.userId,
        vendor: body.vendor,
        product: body.product,
        amount: body.amount,
        currency: body.currency,
        quantity: body.quantity,
        category: body.category,
        targetProtocol: body.targetProtocol,
        targetUrl,
      });

      const status = result.decision.decision === "blocked" ? 403 : 200;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          requestId: result.requestId,
          transactionId: result.transactionId,
          decision: result.decision.decision,
          compositeScore: result.decision.compositeScore,
          explanation: result.decision.explanation,
          released: result.released,
        })
      );
    } catch (error) {
      // Fail-closed: block the transaction on errors
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "GOVERNANCE_FAILURE",
          message:
            error instanceof Error ? error.message : "Unknown error",
          decision: "blocked",
          reason: "Fail-closed: governance pipeline error",
        })
      );
    }
  }

  private matchesPattern(url: string): boolean {
    return this.config.targetPatterns.some((pattern) => {
      // SEC-17: Properly escape all regex metacharacters in the pattern before
      // converting glob wildcards (*) to .* — previously only dots were escaped,
      // allowing other metacharacters (e.g. +, ?, (, )) to inject regex syntax.
      const escaped = pattern
        .split("*")
        .map((segment) => segment.replace(/[\\^$.|?+()[\]{}]/g, "\\$&"))
        .join(".*");
      const regex = new RegExp("^" + escaped + "$");
      return regex.test(url);
    });
  }
}

// ---------------------------------------------------------------------------
// SEC-4: Body reader with configurable size limit.
// Throws an Error with message "REQUEST_TOO_LARGE" if the accumulated bytes
// exceed maxBytes so that the caller can respond with 413.
// ---------------------------------------------------------------------------
function readBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let tooLarge = false;

    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return; // drain without accumulating
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        tooLarge = true;
        chunks.length = 0; // release any already-accumulated memory
        return;
      }
      chunks.push(chunk);
    });

    // Resolve/reject only on "end" so the socket remains open long enough for
    // the caller to write a 413 response before the connection is torn down.
    req.on("end", () => {
      if (tooLarge) {
        reject(new Error("REQUEST_TOO_LARGE"));
        return;
      }
      if (chunks.length === 0) return resolve(null);
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });

    req.on("error", () => resolve(null));
  });
}
