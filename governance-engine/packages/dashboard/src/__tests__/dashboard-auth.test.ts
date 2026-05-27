import { describe, it, expect } from "vitest";
import {
  checkApiKey,
  extractBearerToken,
  checkCsrfOrigin,
} from "../lib/dashboard-auth.js";

// =============================================================================
// SEC-6: API key validation
// =============================================================================

describe("checkApiKey (SEC-6)", () => {
  it("allows any request when no key is configured (dev mode)", () => {
    expect(checkApiKey(null, undefined)).toBe(true);
    expect(checkApiKey("anything", undefined)).toBe(true);
    expect(checkApiKey("", undefined)).toBe(true);
  });

  it("rejects when key is configured and none is provided", () => {
    expect(checkApiKey(null, "secret-key")).toBe(false);
  });

  it("rejects when the provided key does not match", () => {
    expect(checkApiKey("wrong-key", "secret-key")).toBe(false);
    expect(checkApiKey("SECRET-KEY", "secret-key")).toBe(false); // case-sensitive
    expect(checkApiKey("secret-key ", "secret-key")).toBe(false); // trailing space
  });

  it("accepts when the provided key matches exactly", () => {
    expect(checkApiKey("secret-key", "secret-key")).toBe(true);
  });

  it("accepts a complex high-entropy key", () => {
    const key = "auzaar_sk_prod_x9f2mQrT8pLvWkNj3YeU";
    expect(checkApiKey(key, key)).toBe(true);
    expect(checkApiKey(key.slice(0, -1), key)).toBe(false);
  });
});

// =============================================================================
// extractBearerToken
// =============================================================================

describe("extractBearerToken", () => {
  it("returns null for a null header", () => {
    expect(extractBearerToken(null)).toBeNull();
  });

  it("returns null for a non-Bearer scheme", () => {
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(extractBearerToken("ApiKey abc123")).toBeNull();
  });

  it("returns null when the prefix is missing but value is present", () => {
    expect(extractBearerToken("abc123")).toBeNull();
  });

  it("extracts the token from a valid Bearer header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("handles tokens with internal hyphens and dots", () => {
    expect(extractBearerToken("Bearer sk-prod.abc.def")).toBe("sk-prod.abc.def");
  });
});

// =============================================================================
// SEC-10: CSRF origin validation
// =============================================================================

describe("checkCsrfOrigin (SEC-10)", () => {
  // --- Non-mutating methods are always allowed ---

  it("always allows GET regardless of origin or config", () => {
    expect(checkCsrfOrigin(null, "GET", "https://dashboard.acme.com")).toBe(true);
    expect(checkCsrfOrigin("https://evil.com", "GET", "https://dashboard.acme.com")).toBe(true);
  });

  it("always allows HEAD", () => {
    expect(checkCsrfOrigin(null, "HEAD", "https://dashboard.acme.com")).toBe(true);
  });

  it("always allows OPTIONS", () => {
    expect(checkCsrfOrigin(null, "OPTIONS", "https://dashboard.acme.com")).toBe(true);
  });

  // --- CSRF protection disabled (env var not set) ---

  it("allows POST when CSRF protection is not configured", () => {
    expect(checkCsrfOrigin(null, "POST", undefined)).toBe(true);
    expect(checkCsrfOrigin("https://evil.com", "POST", undefined)).toBe(true);
  });

  it("allows DELETE when CSRF protection is not configured", () => {
    expect(checkCsrfOrigin(null, "DELETE", undefined)).toBe(true);
  });

  // --- CSRF protection enabled ---

  it("rejects POST with no Origin header when CSRF is configured", () => {
    expect(
      checkCsrfOrigin(null, "POST", "https://dashboard.acme.com")
    ).toBe(false);
  });

  it("rejects POST from a disallowed origin", () => {
    expect(
      checkCsrfOrigin("https://evil.com", "POST", "https://dashboard.acme.com")
    ).toBe(false);
  });

  it("rejects PUT from a disallowed origin", () => {
    expect(
      checkCsrfOrigin("https://evil.com", "PUT", "https://dashboard.acme.com")
    ).toBe(false);
  });

  it("rejects PATCH from a disallowed origin", () => {
    expect(
      checkCsrfOrigin("https://phishing.io", "PATCH", "https://dashboard.acme.com")
    ).toBe(false);
  });

  it("rejects DELETE from a disallowed origin", () => {
    expect(
      checkCsrfOrigin("https://attacker.io", "DELETE", "https://dashboard.acme.com")
    ).toBe(false);
  });

  it("allows POST from the single configured origin", () => {
    expect(
      checkCsrfOrigin(
        "https://dashboard.acme.com",
        "POST",
        "https://dashboard.acme.com"
      )
    ).toBe(true);
  });

  it("allows POST from a second origin in a comma-separated list", () => {
    const allowed = "https://dashboard.acme.com,https://staging.acme.com";
    expect(checkCsrfOrigin("https://staging.acme.com", "POST", allowed)).toBe(true);
  });

  it("allows all listed origins", () => {
    const allowed = "https://a.com, https://b.com, https://c.com";
    expect(checkCsrfOrigin("https://a.com", "POST", allowed)).toBe(true);
    expect(checkCsrfOrigin("https://b.com", "DELETE", allowed)).toBe(true);
    expect(checkCsrfOrigin("https://c.com", "PATCH", allowed)).toBe(true);
  });

  it("is case-sensitive — a capitalised origin does not match", () => {
    expect(
      checkCsrfOrigin(
        "HTTPS://dashboard.acme.com",
        "POST",
        "https://dashboard.acme.com"
      )
    ).toBe(false);
  });

  it("does not allow a subdomain that is not explicitly listed", () => {
    expect(
      checkCsrfOrigin(
        "https://admin.dashboard.acme.com",
        "POST",
        "https://dashboard.acme.com"
      )
    ).toBe(false);
  });

  it("trims whitespace from configured origins", () => {
    // Extra whitespace around the comma should not cause valid origins to fail
    expect(
      checkCsrfOrigin(
        "https://dashboard.acme.com",
        "POST",
        "  https://dashboard.acme.com  ,  https://other.com  "
      )
    ).toBe(true);
  });

  it("is method check case-insensitive (post == POST)", () => {
    // checkCsrfOrigin uppercases the method internally
    expect(
      checkCsrfOrigin(
        "https://evil.com",
        "post",
        "https://dashboard.acme.com"
      )
    ).toBe(false);
    expect(
      checkCsrfOrigin(
        "https://dashboard.acme.com",
        "post",
        "https://dashboard.acme.com"
      )
    ).toBe(true);
  });
});
