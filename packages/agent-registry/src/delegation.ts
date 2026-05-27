import type { DelegationLink } from "@auzaar/core";
import { type Result, ok, err, GovernanceError } from "@auzaar/core";

export function verifyDelegationChain(
  chain: DelegationLink[]
): Result<boolean> {
  if (chain.length === 0) {
    return ok(true);
  }

  const now = new Date().toISOString();

  for (let i = 0; i < chain.length; i++) {
    const link = chain[i];

    // Check expiration
    if (link.expiresAt && link.expiresAt < now) {
      return err(
        new GovernanceError(
          `Delegation link at index ${i} has expired`,
          {
            delegatorId: link.delegatorId,
            delegateeId: link.delegateeId,
            expiresAt: link.expiresAt,
          }
        )
      );
    }

    // Check contiguity: each delegatee must be the next delegator
    if (i < chain.length - 1) {
      const nextLink = chain[i + 1];
      if (link.delegateeId !== nextLink.delegatorId) {
        return err(
          new GovernanceError(
            `Delegation chain is not contiguous at index ${i}: delegatee '${link.delegateeId}' does not match next delegator '${nextLink.delegatorId}'`,
            {
              index: i,
              delegateeId: link.delegateeId,
              nextDelegatorId: nextLink.delegatorId,
            }
          )
        );
      }
    }
  }

  return ok(true);
}
