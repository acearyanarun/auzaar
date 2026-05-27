import { randomBytes } from "node:crypto";

export function generateId(prefix: string): string {
  const bytes = randomBytes(12);
  const hex = bytes.toString("hex");
  return `${prefix}_${hex}`;
}

export function generateRequestId(): string {
  return generateId("req");
}

export function generateMandateId(): string {
  return generateId("mdt");
}

export function generateAgentId(): string {
  return generateId("agt");
}

export function generateEventId(): string {
  return generateId("evt");
}

export function generatePolicyId(): string {
  return generateId("pol");
}

export function generateTransactionId(): string {
  return generateId("txn");
}
