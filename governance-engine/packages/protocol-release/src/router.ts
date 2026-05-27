import type { Transaction, GovernanceDecision, Result } from "@auzaar/core";
import { ok, err, GovernanceError } from "@auzaar/core";
import { createAttestation, serializeAttestation } from "./attestation.js";

export type Protocol = "acp" | "ucp" | "ap2" | "direct";

export interface ReleasePayload {
  transaction: Transaction;
  attestationHeader: string;
  targetUrl?: string;
  protocol: Protocol;
  headers: Record<string, string>;
}

export interface ReleaseResult {
  released: boolean;
  payload: ReleasePayload;
}

export class ProtocolRouter {
  release(
    transaction: Transaction,
    mandateId: string,
    decision: GovernanceDecision
  ): Result<ReleaseResult> {
    if (decision.decision !== "approved") {
      return err(
        new GovernanceError(
          `Cannot release transaction with decision: ${decision.decision}`,
          { requestId: decision.requestId, decision: decision.decision }
        )
      );
    }

    const attestation = createAttestation(mandateId, decision);
    const attestationHeader = serializeAttestation(attestation);
    const protocol = this.resolveProtocol(transaction);

    const payload: ReleasePayload = {
      transaction,
      attestationHeader,
      targetUrl: transaction.targetUrl,
      protocol,
      headers: {
        "X-Auzaar-Attestation": attestationHeader,
        "X-Auzaar-Mandate-Id": mandateId,
        "X-Auzaar-Request-Id": decision.requestId,
      },
    };

    return ok({ released: true, payload });
  }

  private resolveProtocol(transaction: Transaction): Protocol {
    return transaction.targetProtocol ?? "direct";
  }
}
