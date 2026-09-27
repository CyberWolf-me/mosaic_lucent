import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Sealing OAuth tokens at rest (docs/26 A5). The reference-first rule (ADR
 * 0030) kept every credential out of the database — the connection named an
 * environment variable. OAuth can't work that way: the provider hands the
 * token to Lucent, per org, and it expires and rotates. So the token is
 * stored, and sealed: AES-256-GCM under a key the operator sets
 * (`LUCENT_TOKEN_KEY`, 32 random bytes as base64), with the row it belongs
 * to — `org:provider` — bound in as associated data, so a sealed token copied
 * onto another org's row does not open. No key, no OAuth: the server never
 * stores a token it can't seal.
 */

export interface TokenBox {
  seal(plaintext: string, boundTo: string): string;
  open(sealed: string, boundTo: string): string;
}

const VERSION = "v1";

export function tokenBox(keyBase64: string | undefined): TokenBox | null {
  if (!keyBase64) return null;
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error("LUCENT_TOKEN_KEY must be 32 random bytes, base64-encoded");
  }
  return {
    seal(plaintext, boundTo) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(boundTo, "utf8"));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [
        VERSION,
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        body.toString("base64url"),
      ].join(".");
    },
    open(sealed, boundTo) {
      const [version, iv, tag, body] = sealed.split(".");
      if (version !== VERSION || !iv || !tag || body === undefined) {
        throw new Error("not a sealed token");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(boundTo, "utf8"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(body, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
