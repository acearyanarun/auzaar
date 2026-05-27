import { createPrivateKey } from "node:crypto";
import {
  type Mandate,
  type StructuredIntent,
  type Result,
  ok,
  err,
  MandateNotFoundError,
  MandateExpiredError,
  MandateRevokedError,
  MandateAmendedError,
  MandateIntegrityError,
  StorageError,
  generateMandateId,
  signData,
  verifySignature,
  derivePublicKey,
} from "@auzaar/core";
import type { MandateStore } from "./store.js";
import { parseIntent } from "./parser.js";

/**
 * SEC-18: Canonical JSON serialization with recursively sorted keys.
 * Prevents key-ordering mismatches between sign and verify paths that could
 * occur if object literals are constructed in different insertion orders.
 */
function canonicalJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJsonStringify).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJsonStringify((value as Record<string, unknown>)[k])}`
      );
    return "{" + entries.join(",") + "}";
  }
  return JSON.stringify(value);
}

export class MandateService {
  private readonly store: MandateStore;
  private readonly privateKey: string;
  private readonly publicKey: string;

  constructor(store: MandateStore, privateKey: string) {
    // SEC-13: Validate key format and algorithm at construction time so that
    // misconfigured deployments fail fast before any mandates are signed.
    try {
      const keyObj = createPrivateKey(privateKey);
      if (keyObj.asymmetricKeyType !== "ed25519") {
        throw new Error(
          `Expected Ed25519 key, got: ${keyObj.asymmetricKeyType ?? "unknown"}`
        );
      }
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`MandateService: invalid private key — ${reason}`);
    }

    this.store = store;
    this.privateKey = privateKey;
    this.publicKey = derivePublicKey(privateKey);
  }

  /**
   * Builds the canonical JSON string that is signed/verified for a mandate.
   * Key order is fixed so that serialization is deterministic across sign and
   * verify paths.  previousVersionId is included only when present so that v1
   * mandates (no previousVersionId) hash identically to how they were created.
   */
  private static buildSignableContent(fields: {
    id: string;
    userId: string;
    agentId: string;
    intentText: string;
    structuredIntent: StructuredIntent;
    version: number;
    previousVersionId?: string;
    createdAt: string;
  }): string {
    const obj: Record<string, unknown> = {
      id: fields.id,
      userId: fields.userId,
      agentId: fields.agentId,
      intentText: fields.intentText,
      structuredIntent: fields.structuredIntent,
      version: fields.version,
    };
    if (fields.previousVersionId !== undefined) {
      obj["previousVersionId"] = fields.previousVersionId;
    }
    obj["createdAt"] = fields.createdAt;
    // SEC-18: Use canonical JSON (sorted keys) to ensure sign and verify
    // produce identical byte sequences regardless of object construction order.
    return canonicalJsonStringify(obj);
  }

  async createMandate(
    userId: string,
    agentId: string,
    intentText: string,
    structuredFields: Partial<StructuredIntent>
  ): Promise<Result<Mandate>> {
    const intentResult = parseIntent(intentText, structuredFields);
    if (!intentResult.ok) {
      return intentResult;
    }

    const id = generateMandateId();
    const now = new Date().toISOString();

    const contentToSign = MandateService.buildSignableContent({
      id,
      userId,
      agentId,
      intentText,
      structuredIntent: intentResult.value,
      version: 1,
      createdAt: now,
    });

    let signature: string;
    try {
      signature = signData(contentToSign, this.privateKey);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown signing error";
      return err(new StorageError(`Failed to sign mandate: ${message}`));
    }

    const mandate: Mandate = {
      id,
      userId,
      agentId,
      intentText,
      structuredIntent: intentResult.value,
      signature,
      version: 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.store.save(mandate);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown storage error";
      return err(new StorageError(`Failed to save mandate: ${message}`));
    }

    return ok(mandate);
  }

  async getMandate(mandateId: string): Promise<Result<Mandate>> {
    let mandate: Mandate | null;
    try {
      mandate = await this.store.getById(mandateId);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown storage error";
      return err(new StorageError(`Failed to retrieve mandate: ${message}`));
    }

    if (!mandate) {
      return err(new MandateNotFoundError(mandateId));
    }

    // Status guards — cheapest checks first, before any cryptographic work
    if (mandate.status === "expired") {
      return err(new MandateExpiredError(mandateId));
    }
    if (mandate.status === "revoked") {
      return err(new MandateRevokedError(mandateId));
    }
    if (mandate.status === "amended") {
      return err(new MandateAmendedError(mandateId));
    }

    // SEC-1: Verify the Ed25519 signature to detect storage tampering
    const contentToVerify = MandateService.buildSignableContent({
      id: mandate.id,
      userId: mandate.userId,
      agentId: mandate.agentId,
      intentText: mandate.intentText,
      structuredIntent: mandate.structuredIntent,
      version: mandate.version,
      previousVersionId: mandate.previousVersionId,
      createdAt: mandate.createdAt,
    });

    let signatureValid: boolean;
    try {
      signatureValid = verifySignature(contentToVerify, mandate.signature, this.publicKey);
    } catch {
      return err(new MandateIntegrityError(mandateId));
    }

    if (!signatureValid) {
      return err(new MandateIntegrityError(mandateId));
    }

    return ok(mandate);
  }

  async amendMandate(
    mandateId: string,
    changes: Partial<StructuredIntent>
  ): Promise<Result<Mandate>> {
    const existingResult = await this.getMandate(mandateId);
    if (!existingResult.ok) {
      return existingResult;
    }

    const existing = existingResult.value;

    const mergedFields: Partial<StructuredIntent> = {
      ...existing.structuredIntent,
      ...changes,
    };

    // Merge nested vendorPreferences if both exist
    if (existing.structuredIntent.vendorPreferences && changes.vendorPreferences) {
      mergedFields.vendorPreferences = {
        ...existing.structuredIntent.vendorPreferences,
        ...changes.vendorPreferences,
      };
    }

    // Merge nested timing if both exist
    if (existing.structuredIntent.timing && changes.timing) {
      mergedFields.timing = {
        ...existing.structuredIntent.timing,
        ...changes.timing,
      };
    }

    const intentResult = parseIntent(existing.intentText, mergedFields);
    if (!intentResult.ok) {
      return intentResult;
    }

    const newId = generateMandateId();
    const now = new Date().toISOString();
    const newVersion = existing.version + 1;

    const contentToSign = MandateService.buildSignableContent({
      id: newId,
      userId: existing.userId,
      agentId: existing.agentId,
      intentText: existing.intentText,
      structuredIntent: intentResult.value,
      version: newVersion,
      previousVersionId: existing.id,
      createdAt: now,
    });

    let signature: string;
    try {
      signature = signData(contentToSign, this.privateKey);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown signing error";
      return err(new StorageError(`Failed to sign amended mandate: ${message}`));
    }

    const amendedMandate: Mandate = {
      id: newId,
      userId: existing.userId,
      agentId: existing.agentId,
      intentText: existing.intentText,
      structuredIntent: intentResult.value,
      signature,
      version: newVersion,
      previousVersionId: existing.id,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    // Mark old mandate as amended and save both
    const updatedOld: Mandate = {
      ...existing,
      status: "amended",
      updatedAt: now,
    };

    try {
      await this.store.save(updatedOld);
      await this.store.save(amendedMandate);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown storage error";
      return err(new StorageError(`Failed to save amended mandate: ${message}`));
    }

    return ok(amendedMandate);
  }
}
