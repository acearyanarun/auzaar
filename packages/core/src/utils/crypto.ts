import { generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

export function signData(data: string, privateKey: string): string {
  const signature = sign(null, Buffer.from(data), privateKey);
  return signature.toString("base64");
}

export function verifySignature(
  data: string,
  signature: string,
  publicKey: string
): boolean {
  return verify(null, Buffer.from(data), publicKey, Buffer.from(signature, "base64"));
}

/**
 * Derives the PEM-encoded public key from a PEM-encoded Ed25519 private key.
 * Used so callers only need to supply the private key — the public key for
 * signature verification is derived automatically.
 */
export function derivePublicKey(privateKey: string): string {
  return createPublicKey(privateKey).export({ type: "spki", format: "pem" }) as string;
}
