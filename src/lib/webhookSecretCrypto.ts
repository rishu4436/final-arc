import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Phase 13 (P3-06): webhook signing secrets at rest.
 *
 * New and rotated secrets are stored as AES-256-GCM ciphertext:
 *   enc:v1:<base64url iv(12)>:<base64url ciphertext||tag(16)>
 * The GCM additional data binds the ciphertext to the endpoint id and merchant, so a
 * stored value cannot be copied onto another endpoint and still decrypt.
 *
 * Key: FINAL_WEBHOOK_ENCRYPTION_KEY, exactly 32 bytes encoded as 64 hex characters or
 * base64/base64url. The key is never logged, returned, or persisted.
 *
 * Legacy rows that still hold a plaintext `whsec_…` secret keep working (read path) and
 * are re-encrypted the next time the endpoint is updated while a key is configured.
 * Creating or rotating a secret without a valid key fails closed: no plaintext is written.
 */

export const WEBHOOK_SECRET_CIPHER_PREFIX = "enc:v1:";
export const WEBHOOK_ENCRYPTION_KEY_ENV = "FINAL_WEBHOOK_ENCRYPTION_KEY";

export class WebhookSecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSecretCryptoError";
  }
}

/** Parses the configured key. Returns null when unset/blank or malformed (never throws, never echoes the value). */
export function parseWebhookEncryptionKey(raw: string | undefined | null): Buffer | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  if (/^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(value)) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(normalized, "base64");
    if (buf.length === 32) return buf;
  }
  return null;
}

export function webhookEncryptionKeyFromEnv(): Buffer | null {
  return parseWebhookEncryptionKey(process.env[WEBHOOK_ENCRYPTION_KEY_ENV]);
}

export function isEncryptedWebhookSecret(stored: string): boolean {
  return stored.startsWith(WEBHOOK_SECRET_CIPHER_PREFIX);
}

function aad(endpointId: string, merchant: string): Buffer {
  return Buffer.from(`final-webhook-secret:v1:${endpointId}:${merchant.toLowerCase()}`, "utf8");
}

export function encryptWebhookSecret(
  plaintext: string,
  binding: { endpointId: string; merchant: string },
  key: Buffer | null,
): string {
  if (!key || key.length !== 32) {
    throw new WebhookSecretCryptoError("Webhook secret encryption is not configured.");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(binding.endpointId, binding.merchant));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${WEBHOOK_SECRET_CIPHER_PREFIX}${iv.toString("base64url")}:${ct.toString("base64url")}`;
}

/**
 * Returns the signing secret. Legacy plaintext is returned unchanged. Ciphertext without a
 * valid key, with a wrong key, or bound to another endpoint throws (callers fail closed).
 */
export function decryptWebhookSecret(
  stored: string,
  binding: { endpointId: string; merchant: string },
  key: Buffer | null,
): string {
  if (!isEncryptedWebhookSecret(stored)) return stored;
  if (!key || key.length !== 32) {
    throw new WebhookSecretCryptoError("Webhook secret encryption key is unavailable.");
  }
  const parts = stored.slice(WEBHOOK_SECRET_CIPHER_PREFIX.length).split(":");
  if (parts.length !== 2) throw new WebhookSecretCryptoError("Stored webhook secret is malformed.");
  const iv = Buffer.from(parts[0], "base64url");
  const blob = Buffer.from(parts[1], "base64url");
  if (iv.length !== 12 || blob.length < 17) throw new WebhookSecretCryptoError("Stored webhook secret is malformed.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad(binding.endpointId, binding.merchant));
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    return Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    throw new WebhookSecretCryptoError("Stored webhook secret could not be decrypted.");
  }
}
