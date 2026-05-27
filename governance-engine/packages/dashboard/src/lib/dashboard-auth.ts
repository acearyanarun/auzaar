/**
 * Pure helper functions for dashboard API authentication (SEC-6) and CSRF
 * origin validation (SEC-10).
 *
 * These functions have no Next.js or browser dependencies so they can be unit
 * tested without a framework runtime.
 */

/**
 * SEC-6: Validates an API key against the expected value.
 *
 * If `expectedKey` is undefined (env var not set), auth is treated as
 * unconfigured and every request is allowed — this preserves developer
 * convenience in local environments without AUZAAR_DASHBOARD_API_KEY set.
 *
 * In production, AUZAAR_DASHBOARD_API_KEY must be set to a non-empty string.
 */
export function checkApiKey(
  providedKey: string | null,
  expectedKey: string | undefined
): boolean {
  if (!expectedKey) return true; // auth not configured — open access
  if (!providedKey) return false;
  return providedKey === expectedKey;
}

/**
 * Extracts a Bearer token from an Authorization header value.
 * Returns null if the header is absent or not in Bearer format.
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

/**
 * SEC-10: Validates the Origin header of a mutating HTTP request against the
 * configured allowed-origins list.
 *
 * Rules:
 * - Non-mutating methods (GET, HEAD, OPTIONS) are always allowed.
 * - If `allowedOriginsEnv` is not set, CSRF protection is not active (dev
 *   convenience). Set AUZAAR_DASHBOARD_ORIGIN in production.
 * - For mutating requests with CSRF protection active, the Origin header must
 *   be present and must exactly match one of the configured origins.
 *
 * `allowedOriginsEnv` is a comma-separated list of allowed origins,
 * e.g. "https://dashboard.acme.com" or "https://a.com,https://b.com".
 */
export function checkCsrfOrigin(
  origin: string | null,
  method: string,
  allowedOriginsEnv: string | undefined
): boolean {
  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(
    method.toUpperCase()
  );
  if (!isMutating) return true;
  if (!allowedOriginsEnv) return true; // CSRF protection not configured

  if (!origin) return false; // mutating request with no Origin = reject

  const allowed = allowedOriginsEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}
