import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  checkApiKey,
  checkCsrfOrigin,
  extractBearerToken,
} from "@/lib/dashboard-auth";

/**
 * Next.js middleware that enforces two security controls on all /api/* routes:
 *
 * SEC-6 — API key authentication
 *   Reads the key from the X-Dashboard-Api-Key header (preferred) or from a
 *   Bearer token in the Authorization header.  Compared against the
 *   AUZAAR_DASHBOARD_API_KEY environment variable.  If the env var is not set
 *   (e.g. local development) authentication is skipped with a warning emitted
 *   server-side.
 *
 * SEC-10 — CSRF origin check
 *   For POST / PUT / PATCH / DELETE requests, the Origin header must match one
 *   of the comma-separated values in AUZAAR_DASHBOARD_ORIGIN.  If the env var
 *   is not set CSRF protection is not active (dev convenience).
 */
export function middleware(request: NextRequest): NextResponse {
  if (!request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // SEC-6: API key check
  const expectedKey = process.env.AUZAAR_DASHBOARD_API_KEY;

  if (!expectedKey) {
    // Warn once per cold-start — visible in server logs
    console.warn(
      "[auzaar/dashboard] WARNING: AUZAAR_DASHBOARD_API_KEY is not set. " +
        "Dashboard API routes are accessible without authentication. " +
        "Set this environment variable before deploying to production."
    );
  }

  const providedKey =
    request.headers.get("x-dashboard-api-key") ??
    extractBearerToken(request.headers.get("authorization"));

  if (!checkApiKey(providedKey, expectedKey)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // SEC-10: CSRF origin check (mutating methods only)
  const allowedOrigins = process.env.AUZAAR_DASHBOARD_ORIGIN;

  if (!allowedOrigins && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    console.warn(
      "[auzaar/dashboard] WARNING: AUZAAR_DASHBOARD_ORIGIN is not set. " +
        "CSRF protection is disabled. " +
        "Set this environment variable before deploying to production."
    );
  }

  const originOk = checkCsrfOrigin(
    request.headers.get("origin"),
    request.method,
    allowedOrigins
  );

  if (!originOk) {
    return NextResponse.json(
      { error: "Forbidden: request origin is not allowed" },
      { status: 403 }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
