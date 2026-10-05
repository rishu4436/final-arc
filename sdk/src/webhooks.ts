import { createHmac, timingSafeEqual } from "node:crypto";
import { FinalWebhookSignatureError } from "./errors";
import type { WebhookEvent, WebhookEventType } from "./types";
import { WEBHOOK_EVENT_CATALOG } from "./types";

/** Same window the server uses. */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

const HEX_SIGNATURE = /^[0-9a-f]+$/i;

function signBody(secret: string, timestampSeconds: number, rawBody: string): string {
  const payload = `${timestampSeconds}.${rawBody}`;
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function timingSafeEqualHex(left: string, right: string): boolean {
  if (!HEX_SIGNATURE.test(left) || !HEX_SIGNATURE.test(right)) return false;
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  } catch {
    return false;
  }
}

function isCatalogType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_CATALOG as readonly string[]).includes(value);
}

export type VerifyWebhookSignatureInput = {
  /** Exact raw HTTP body. Do not pass a parsed object. */
  payload: string;
  signature: string | null;
  timestamp: string | number | null;
  secret: string;
  nowSeconds?: number;
};

/**
 * Verify a FINAL webhook signature over the raw body.
 * HMAC-SHA256 of `${timestamp}.${rawBody}`, hex, optional `sha256=` prefix.
 * Timestamp must be within 300 seconds of nowSeconds (default: current time).
 * Returns the parsed JSON event. Does not deliver or emit events.
 */
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): WebhookEvent {
  if (typeof input.payload !== "string") {
    throw new FinalWebhookSignatureError("malformed_payload", "Webhook payload must be the raw request body.");
  }
  if (typeof input.secret !== "string" || input.secret.length === 0) {
    throw new FinalWebhookSignatureError("malformed_signature", "Webhook signature is malformed.");
  }
  if (input.timestamp == null || (typeof input.timestamp === "string" && input.timestamp.trim().length === 0)) {
    throw new FinalWebhookSignatureError("malformed_signature", "Webhook signature is malformed.");
  }
  const timestamp = typeof input.timestamp === "number" ? input.timestamp : Number(input.timestamp);
  if (!Number.isFinite(timestamp) || !Number.isSafeInteger(timestamp)) {
    throw new FinalWebhookSignatureError("malformed_signature", "Webhook signature is malformed.");
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    throw new FinalWebhookSignatureError("stale_timestamp", "Webhook timestamp is outside the allowed window.");
  }
  if (typeof input.signature !== "string" || input.signature.trim().length === 0) {
    throw new FinalWebhookSignatureError("malformed_signature", "Webhook signature is malformed.");
  }
  const provided = input.signature.trim().toLowerCase().replace(/^sha256=/i, "");
  if (!HEX_SIGNATURE.test(provided) || provided.length % 2 !== 0) {
    throw new FinalWebhookSignatureError("malformed_signature", "Webhook signature is malformed.");
  }
  const expected = signBody(input.secret, timestamp, input.payload);
  if (!timingSafeEqualHex(expected, provided)) {
    throw new FinalWebhookSignatureError("invalid_signature", "Webhook signature is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.payload) as unknown;
  } catch {
    throw new FinalWebhookSignatureError("malformed_payload", "Webhook payload is not JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FinalWebhookSignatureError("malformed_payload", "Webhook payload is not a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.type !== "string" || !isCatalogType(record.type)) {
    throw new FinalWebhookSignatureError("malformed_payload", "Webhook payload is not a FINAL event.");
  }
  if (typeof record.createdAt !== "string" || typeof record.merchant !== "string") {
    throw new FinalWebhookSignatureError("malformed_payload", "Webhook payload is not a FINAL event.");
  }
  const data = record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new FinalWebhookSignatureError("malformed_payload", "Webhook payload is not a FINAL event.");
  }
  return {
    id: record.id,
    type: record.type,
    createdAt: record.createdAt,
    merchant: record.merchant,
    data: data as Record<string, unknown>,
  };
}

export class Webhooks {
  verifySignature(input: VerifyWebhookSignatureInput): WebhookEvent {
    return verifyWebhookSignature(input);
  }
}
