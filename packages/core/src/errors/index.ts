export class AuzaarError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AuzaarError";
  }
}

export class MandateNotFoundError extends AuzaarError {
  constructor(mandateId: string) {
    super(`Mandate not found: ${mandateId}`, "MANDATE_NOT_FOUND", { mandateId });
    this.name = "MandateNotFoundError";
  }
}

export class MandateExpiredError extends AuzaarError {
  constructor(mandateId: string) {
    super(`Mandate expired: ${mandateId}`, "MANDATE_EXPIRED", { mandateId });
    this.name = "MandateExpiredError";
  }
}

export class AgentNotFoundError extends AuzaarError {
  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`, "AGENT_NOT_FOUND", { agentId });
    this.name = "AgentNotFoundError";
  }
}

export class AgentSuspendedError extends AuzaarError {
  constructor(agentId: string) {
    super(`Agent is suspended: ${agentId}`, "AGENT_SUSPENDED", { agentId });
    this.name = "AgentSuspendedError";
  }
}

export class PolicyValidationError extends AuzaarError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "POLICY_VALIDATION_ERROR", details);
    this.name = "PolicyValidationError";
  }
}

export class GovernanceError extends AuzaarError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "GOVERNANCE_ERROR", details);
    this.name = "GovernanceError";
  }
}

export class StorageError extends AuzaarError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "STORAGE_ERROR", details);
    this.name = "StorageError";
  }
}

export class MandateRevokedError extends AuzaarError {
  constructor(mandateId: string) {
    super(`Mandate has been revoked: ${mandateId}`, "MANDATE_REVOKED", { mandateId });
    this.name = "MandateRevokedError";
  }
}

export class MandateAmendedError extends AuzaarError {
  constructor(mandateId: string) {
    super(`Mandate has been superseded by a newer version: ${mandateId}`, "MANDATE_AMENDED", { mandateId });
    this.name = "MandateAmendedError";
  }
}

export class MandateIntegrityError extends AuzaarError {
  constructor(mandateId: string) {
    super(`Mandate signature verification failed: ${mandateId}`, "MANDATE_INTEGRITY_ERROR", { mandateId });
    this.name = "MandateIntegrityError";
  }
}

export type Result<T, E = AuzaarError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
