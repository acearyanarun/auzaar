export interface AuthResult {
  authenticated: boolean;
  agentId?: string;
  userId?: string;
  /**
   * SEC-12: Always "Unauthorized" when authentication fails.
   * Safe to surface in HTTP responses without leaking auth internals.
   */
  error?: string;
  /**
   * SEC-12: Specific reason for internal logging only.
   * MUST NOT be included in HTTP response bodies.
   */
  internalReason?: string;
}

export type AuthMode = "none" | "bearer" | "api-key";

export interface AuthConfig {
  mode: AuthMode;
  apiKeys?: Map<string, { agentId: string; userId: string }>;
}

export function authenticate(
  authHeader: string | undefined,
  config: AuthConfig
): AuthResult {
  if (config.mode === "none") {
    return { authenticated: true };
  }

  if (!authHeader) {
    return {
      authenticated: false,
      error: "Unauthorized",
      internalReason: "Missing authorization header",
    };
  }

  if (config.mode === "bearer") {
    if (!authHeader.startsWith("Bearer ")) {
      return {
        authenticated: false,
        error: "Unauthorized",
        internalReason: "Invalid bearer token format",
      };
    }
    const token = authHeader.slice(7);
    const entry = config.apiKeys?.get(token);
    if (!entry) {
      return {
        authenticated: false,
        error: "Unauthorized",
        internalReason: "Invalid token",
      };
    }
    return { authenticated: true, agentId: entry.agentId, userId: entry.userId };
  }

  if (config.mode === "api-key") {
    const entry = config.apiKeys?.get(authHeader);
    if (!entry) {
      return {
        authenticated: false,
        error: "Unauthorized",
        internalReason: "Invalid API key",
      };
    }
    return { authenticated: true, agentId: entry.agentId, userId: entry.userId };
  }

  return {
    authenticated: false,
    error: "Unauthorized",
    internalReason: "Unknown auth mode",
  };
}
