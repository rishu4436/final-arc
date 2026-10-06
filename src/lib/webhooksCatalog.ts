/** Catalog shared by API docs and the dashboard. No Node builtins. */

export const WEBHOOK_EVENT_CATALOG = [
  "payment_request.created",
  "payment_request.cancelled",
  "payment_request.expired",
  "payment.detected",
  "payment.verified",
  "payment.paid",
  "payment.failed",
  "webhook.test",
  "escrow.created",
  "escrow.opened",
  "escrow.funded",
  "escrow.released",
  "escrow.refunded",
  "escrow.cancelled",
  "agent.payment_intent.created",
  "agent.payment_intent.submitted",
  "agent.payment_intent.verified",
  "agent.payment_intent.failed",
  "agent.payment_intent.policy_denied",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_CATALOG)[number];

/** payment.detected/verified/failed and payment_request.expired are not emitted. payment.paid is emitted exactly once on a real PAID transition (Phase 14). Escrow events are emitted only after a real escrow transition. policy_denied is an audit event, not a payment. */
export const EMITTABLE_WEBHOOK_EVENTS = [
  "payment_request.created",
  "payment_request.cancelled",
  "payment.paid",
  "webhook.test",
  "escrow.created",
  "escrow.opened",
  "escrow.funded",
  "escrow.released",
  "escrow.refunded",
  "escrow.cancelled",
  "agent.payment_intent.created",
  "agent.payment_intent.submitted",
  "agent.payment_intent.verified",
  "agent.payment_intent.failed",
  "agent.payment_intent.policy_denied",
] as const;

export type EmittableWebhookEvent = (typeof EMITTABLE_WEBHOOK_EVENTS)[number];

export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;
export const WEBHOOK_MAX_ATTEMPTS = 5;
/** Delays after attempts 1..4 before attempts 2..5. */
export const WEBHOOK_RETRY_DELAYS_SECONDS = [60, 300, 900, 3600] as const;
/** Claim lease so a crashed worker recovers without blocking forever. */
export const WEBHOOK_CLAIM_LEASE_SECONDS = 60;
/** Bound work per processor invocation (serverless-friendly). */
export const WEBHOOK_MAX_DUE_PER_RUN = 25;
/** HTTP timeout for a single delivery attempt. */
export const WEBHOOK_HTTP_TIMEOUT_MS = 8000;

export const WEBHOOK_HEADERS = {
  id: "X-Final-Webhook-Id",
  timestamp: "X-Final-Webhook-Timestamp",
  signature: "X-Final-Webhook-Signature",
  contentType: "content-type",
} as const;
