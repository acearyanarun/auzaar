import type { GovernanceDecision } from "@auzaar/core";
import { sha256 } from "@auzaar/core";

export interface AttestationHeader {
  mandateId: string;
  requestId: string;
  decision: string;
  decisionHash: string;
  decidedAt: string;
}

export function createAttestation(
  mandateId: string,
  decision: GovernanceDecision
): AttestationHeader {
  const decisionHash = sha256(JSON.stringify(decision));

  return {
    mandateId,
    requestId: decision.requestId,
    decision: decision.decision,
    decisionHash,
    decidedAt: decision.decidedAt,
  };
}

export function serializeAttestation(attestation: AttestationHeader): string {
  return Buffer.from(JSON.stringify(attestation)).toString("base64");
}
