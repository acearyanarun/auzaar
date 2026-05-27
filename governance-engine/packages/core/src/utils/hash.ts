import { createHash } from "node:crypto";

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hashChain(previousHash: string, content: string): string {
  return sha256(previousHash + content);
}
