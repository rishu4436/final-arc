import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { safeLog } from "./safeLog";
import { getAddress, isAddress, parseUnits, type Address } from "viem";
import { deriveMemoId } from "./finalRequest";
import { decodePayLink } from "./payRequest";
import { LIMIT_EXCEEDED_CODE, MAX_WEBHOOK_ENDPOINTS_PER_MERCHANT } from "./resourceLimits";
import {
  mutatePayStoreBlob,
  readPayStoreBlob,
  type PayRecord,
  type WebhookStoreSection,
} from "./payStore";

import {
  EMITTABLE_WEBHOOK_EVENTS,
  WEBHOOK_CLAIM_LEASE_SECONDS,
  WEBHOOK_EVENT_CATALOG,
  WEBHOOK_HEADERS,
  WEBHOOK_HTTP_TIMEOUT_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MAX_DUE_PER_RUN,
  WEBHOOK_RETRY_DELAYS_SECONDS,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  type EmittableWebhookEvent,
  type WebhookEventType,
} from "./webhooksCatalog";

export {
  EMITTABLE_WEBHOOK_EVENTS,
  WEBHOOK_CLAIM_LEASE_SECONDS,
  WEBHOOK_EVENT_CATALOG,
  WEBHOOK_HEADERS,
  WEBHOOK_HTTP_TIMEOUT_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MAX_DUE_PER_RUN,
  WEBHOOK_RETRY_DELAYS_SECONDS,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
};
export type { EmittableWebhookEvent, WebhookEventType };

export type WebhookEndpointRecord = {
  id: string;
  merchant: string;
  url: string;
  enabled: boolean;
  events: WebhookEventType[];
  secret: string;
  createdAt: string;
  updatedAt: string;
};

export type WebhookEndpointPublic = {
  id: string;
  merchant: string;
  url: string;
  enabled: boolean;
  events: WebhookEventType[];
  secretSet: true;
  createdAt: string;
  updatedAt: string;
};

export type WebhookEndpointCreated = WebhookEndpointPublic & { secret: string };

export type WebhookEnvelope = {
  id: string;
  type: EmittableWebhookEvent;
  createdAt: string;
  merchant: string;
  data: Record<string, unknown>;
};

export type WebhookDeliveryStatus = "pending" | "success" | "failed" | "retrying";

export type WebhookDeliveryRecord = {
  deliveryId: string;
  eventId: string;
  eventType: string;
  webhookId: string;
  merchant: string;
  attempt: number;
  status: WebhookDeliveryStatus;
  httpStatus: number | null;
  createdAt: string;
  attemptedAt: string | null;
  nextRetryAt: string | null;
  error: string | null;
  /** Exact JSON body for this event. Used on retries. Never returned by the API. */
  body: string;
  /** Unpredictable claim token. Never returned by the API. */
  leaseOwner: string | null;
  /** ISO lease expiry. Never returned by the API. */
  leaseExpiresAt: string | null;
};

export type WebhookDeliveryPublic = {
  deliveryId: string;
  eventId: string;
  eventType: string;
  webhookId: string;
  attempt: number;
  status: WebhookDeliveryStatus;
  httpStatus: number | null;
  createdAt: string;
  attemptedAt: string | null;
  nextRetryAt: string | null;
  error: string | null;
};

export type WebhookApiError = {
  status: number;
  body: { error: { code: string; message: string } };
};

export type WebhookHttpFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
    redirect?: RequestRedirect;
  },
) => Promise<Response>;

export type WebhookDeps = {
  nowSeconds: () => number;
  fetch: WebhookHttpFetch;
  randomId: (prefix: string) => string;
  createSecret: () => string;
  /**
   * Authenticated merchant for management calls. Emit and retry processing do not use it.
   * Missing caller is 401. A claimed merchant that differs is not trusted.
   */
  caller?: Address;
  /** P2-03: DNS resolution for destination checks. Defaults to dns.lookup. Tests inject stubs. */
  resolveHost?: (hostname: string) => Promise<string[]>;
};

export const WEBHOOK_ERROR_CODES = {
  invalidJson: "invalid_json",
  invalidAddress: "invalid_address",
  invalidUrl: "invalid_url",
  invalidEvents: "invalid_events",
  notFound: "not_found",
  storeUnavailable: "store_unavailable",
  invalidRequest: "invalid_request",
  internal: "internal",
} as const;

function emptySection(): WebhookStoreSection {
  return { endpoints: {}, deliveries: {} };
}

function section(store: { webhooks?: WebhookStoreSection }): WebhookStoreSection {
  if (!store.webhooks) store.webhooks = emptySection();
  if (!store.webhooks.endpoints || typeof store.webhooks.endpoints !== "object") {
    store.webhooks.endpoints = {};
  }
  if (!store.webhooks.deliveries || typeof store.webhooks.deliveries !== "object") {
    store.webhooks.deliveries = {};
  }
  return store.webhooks;
}

function asEndpoint(value: unknown): WebhookEndpointRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.merchant !== "string") return null;
  if (typeof row.url !== "string" || typeof row.secret !== "string") return null;
  if (typeof row.enabled !== "boolean") return null;
  if (!Array.isArray(row.events)) return null;
  if (typeof row.createdAt !== "string" || typeof row.updatedAt !== "string") return null;
  const events = row.events.filter((e): e is WebhookEventType =>
    typeof e === "string" && (WEBHOOK_EVENT_CATALOG as readonly string[]).includes(e),
  );
  return {
    id: row.id,
    merchant: row.merchant,
    url: row.url,
    enabled: row.enabled,
    events,
    secret: row.secret,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function asDelivery(value: unknown): WebhookDeliveryRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.deliveryId !== "string" || typeof row.eventId !== "string") return null;
  if (typeof row.webhookId !== "string" || typeof row.merchant !== "string") return null;
  if (typeof row.eventType !== "string" || typeof row.body !== "string") return null;
  if (typeof row.attempt !== "number" || typeof row.createdAt !== "string") return null;
  if (
    row.status !== "success" &&
    row.status !== "failed" &&
    row.status !== "retrying" &&
    row.status !== "pending"
  ) {
    return null;
  }
  return {
    deliveryId: row.deliveryId,
    eventId: row.eventId,
    eventType: row.eventType,
    webhookId: row.webhookId,
    merchant: row.merchant,
    attempt: row.attempt,
    status: row.status,
    httpStatus: typeof row.httpStatus === "number" ? row.httpStatus : null,
    createdAt: row.createdAt,
    attemptedAt: typeof row.attemptedAt === "string" ? row.attemptedAt : null,
    nextRetryAt: typeof row.nextRetryAt === "string" ? row.nextRetryAt : null,
    error: typeof row.error === "string" ? row.error : null,
    body: row.body,
    leaseOwner: typeof row.leaseOwner === "string" ? row.leaseOwner : null,
    leaseExpiresAt: typeof row.leaseExpiresAt === "string" ? row.leaseExpiresAt : null,
  };
}

export function defaultWebhookDeps(): WebhookDeps {
  return {
    nowSeconds: () => Math.floor(Date.now() / 1000),
    fetch: async (input, init) =>
      fetch(input, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal ?? AbortSignal.timeout(WEBHOOK_HTTP_TIMEOUT_MS),
        redirect: init.redirect ?? "error",
      }),
    randomId: (prefix) => `${prefix}_${randomBytes(16).toString("hex")}`,
    createSecret: () => `whsec_${randomBytes(32).toString("hex")}`,
  };
}

export function webhookApiError(status: number, code: string, message: string): WebhookApiError {
  return { status, body: { error: { code, message } } };
}

export function toPublicEndpoint(row: WebhookEndpointRecord): WebhookEndpointPublic {
  return {
    id: row.id,
    merchant: row.merchant,
    url: row.url,
    enabled: row.enabled,
    events: row.events,
    secretSet: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPublicDelivery(row: WebhookDeliveryRecord): WebhookDeliveryPublic {
  return {
    deliveryId: row.deliveryId,
    eventId: row.eventId,
    eventType: row.eventType,
    webhookId: row.webhookId,
    attempt: row.attempt,
    status: row.status,
    httpStatus: row.httpStatus,
    createdAt: row.createdAt,
    attemptedAt: row.attemptedAt,
    nextRetryAt: row.nextRetryAt,
    error: row.error,
  };
}

export function retryDelaySeconds(failedAttempt: number): number | null {
  if (failedAttempt < 1 || failedAttempt >= WEBHOOK_MAX_ATTEMPTS) return null;
  return WEBHOOK_RETRY_DELAYS_SECONDS[failedAttempt - 1] ?? null;
}

/**
 * Absolute https URLs only. Rejects userinfo, localhost, private/link-local/metadata
 * IPv4 and IPv6 literals. Hostname DNS is re-checked immediately before HTTP
 * (assertSafeWebhookDestination). Redirects are disabled on dispatch.
 *
 * Residual (documented): Node fetch cannot pin the TCP connect to the exact
 * pre-resolved address, so a DNS-rebinding TOCTOU between lookup and connect
 * remains. Consumers should treat webhook delivery as at-least-once to public HTTPS.
 */
export function validateWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookValidationError(WEBHOOK_ERROR_CODES.invalidUrl, "Webhook URL must be an absolute https URL.");
  }
  if (url.protocol !== "https:") {
    throw new WebhookValidationError(WEBHOOK_ERROR_CODES.invalidUrl, "Webhook URL must use https.");
  }
  if (url.username || url.password) {
    throw new WebhookValidationError(WEBHOOK_ERROR_CODES.invalidUrl, "Webhook URL must not include credentials.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "metadata.google.internal" ||
    host === "metadata" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new WebhookValidationError(WEBHOOK_ERROR_CODES.invalidUrl, "Webhook URL host is not allowed.");
  }
  if (isBlockedIp(host)) {
    throw new WebhookValidationError(WEBHOOK_ERROR_CODES.invalidUrl, "Webhook URL host is not allowed.");
  }
  return url.toString();
}

/** Exported for tests. True when the host literal is a blocked IP form. */
export function isBlockedIp(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1" || h === "0:0:0:0:0:0:0:1" || h === "https://example.net/id/garnet") return true;

  // IPv4-mapped IPv6: ::ffff:a.b.c.d or ::ffff:7f00:1 (Node URL normalizes dotted form).
  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(h);
  if (mappedDotted) return isBlockedIp(mappedDotted[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return isBlockedIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
    }
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  // IPv6 compressed/expanded heuristics for private, link-local, ULA, multicast.
  if (h.includes(":")) {
    const normalized = h;
    if (normalized.startsWith("fe80:") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
      return true; // link-local fe80::/10
    }
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // ULA fc00::/7
    if (normalized.startsWith("ff")) return true; // multicast
    if (normalized === "::" || normalized.startsWith("::0") || normalized === "0:0:0:0:0:0:0:0") return true;
    // Documentation / discard
    if (normalized.startsWith("2001:db8:")) return true;
  }
  return false;
}

export class WebhookValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class WebhookHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function parseMerchantAddress(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new WebhookValidationError(
      WEBHOOK_ERROR_CODES.invalidAddress,
      "merchant must be a valid 0x address.",
    );
  }
  return getAddress(value);
}

export function parseEventSubscriptions(value: unknown): WebhookEventType[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WebhookValidationError(
      WEBHOOK_ERROR_CODES.invalidEvents,
      "events must be a non-empty array of catalog event types.",
    );
  }
  const out: WebhookEventType[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !(WEBHOOK_EVENT_CATALOG as readonly string[]).includes(item)) {
      throw new WebhookValidationError(
        WEBHOOK_ERROR_CODES.invalidEvents,
        "events must use catalog event types only.",
      );
    }
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item as WebhookEventType);
  }
  return out;
}

export function signWebhookBody(secret: string, timestampSeconds: number, rawBody: string): string {
  const payload = `${timestampSeconds}.${rawBody}`;
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function timingSafeEqualHex(left: string, right: string): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) return false;
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verify HMAC over the exact raw body. Timestamp must be within tolerance of now.
 */
export function verifyWebhookSignature(opts: {
  secret: string;
  timestamp: string | number;
  rawBody: string;
  signature: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): boolean {
  const ts = typeof opts.timestamp === "number" ? opts.timestamp : Number(opts.timestamp);
  if (!Number.isFinite(ts) || !Number.isSafeInteger(ts)) return false;
  const tolerance = opts.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
  if (Math.abs(opts.nowSeconds - ts) > tolerance) return false;
  const expected = signWebhookBody(opts.secret, ts, opts.rawBody);
  const provided = opts.signature.trim().toLowerCase().replace(/^sha256=/i, "");
  return timingSafeEqualHex(expected, provided);
}

export function assertEmittableEvent(type: string): asserts type is EmittableWebhookEvent {
  if (!(EMITTABLE_WEBHOOK_EVENTS as readonly string[]).includes(type)) {
    throw new Error(`Webhook event type is not emitted in this phase: ${type}`);
  }
}

/**
 * Payload fields from a stored payment row. V1 omits requestId and memoId.
 * amountBaseUnits is a decimal integer string when it can be derived.
 */
export function paymentRequestEventData(row: PayRecord): Record<string, unknown> {
  const data: Record<string, unknown> = {
    token: row.token,
    memo: row.memo,
    merchant: row.to,
    recipient: row.to,
  };
  const link = decodePayLink(row.token);
  if (link?.version === 2) {
    data.requestId = link.request.requestId;
    data.memoId = deriveMemoId(link.request.requestId);
    data.amountBaseUnits = link.request.amountBaseUnits.toString();
    data.expiresAt = link.request.expiresAt;
  } else {
    try {
      data.amountBaseUnits = parseUnits(row.amount, 6).toString();
    } catch {
      // Leave amountBaseUnits absent when the stored amount is not USDC decimals.
    }
  }
  return data;
}

function envelopeJson(envelope: WebhookEnvelope): string {
  return JSON.stringify(envelope);
}

function pruneDeliveries(sectionData: WebhookStoreSection, webhookId: string, keep = 100): void {
  const rows = Object.values(sectionData.deliveries)
    .map(asDelivery)
    .filter((d): d is WebhookDeliveryRecord => !!d && d.webhookId === webhookId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  for (const extra of rows.slice(keep)) {
    delete sectionData.deliveries[extra.deliveryId];
  }
}

async function loadEndpoint(id: string): Promise<WebhookEndpointRecord | null> {
  const store = await readPayStoreBlob();
  return asEndpoint(section(store).endpoints[id]);
}

function sameMerchant(endpoint: WebhookEndpointRecord, merchant: Address): boolean {
  return endpoint.merchant.toLowerCase() === merchant.toLowerCase();
}

/** Cross-merchant access returns the same not_found as a missing id. */
function notFound(): WebhookApiError {
  return webhookApiError(404, WEBHOOK_ERROR_CODES.notFound, "Unknown webhook endpoint.");
}

/**
 * Merchant comes from the authenticated caller. A client-supplied merchant that
 * does not match is never used as authority.
 */
function bindMerchant(claimed: unknown, deps: WebhookDeps, mismatch: "forbidden" | "not_found"): Address {
  if (!deps.caller) {
    throw new WebhookHttpError(401, "unauthorized", "API authentication required");
  }
  if (claimed !== undefined && claimed !== null && claimed !== "") {
    const parsed = parseMerchantAddress(claimed);
    if (parsed.toLowerCase() !== deps.caller.toLowerCase()) {
      if (mismatch === "forbidden") {
        throw new WebhookHttpError(403, "forbidden", "Merchant does not match the API key.");
      }
      throw new WebhookHttpError(404, "not_found", "Unknown webhook endpoint.");
    }
  }
  return deps.caller;
}

export async function createWebhookEndpoint(
  input: { merchant: unknown; url: unknown; events: unknown; enabled?: unknown },
  deps: WebhookDeps = defaultWebhookDeps(),
): Promise<{ status: number; body: WebhookEndpointCreated | WebhookApiError["body"] }> {
  try {
    const merchant = bindMerchant(input.merchant, deps, "forbidden");
    if (typeof input.url !== "string") {
      return webhookApiError(400, WEBHOOK_ERROR_CODES.invalidUrl, "Webhook URL must be an absolute https URL.");
    }
    const url = validateWebhookUrl(input.url);
    const events = parseEventSubscriptions(input.events);
    const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
    const now = new Date(deps.nowSeconds() * 1000).toISOString();
    const row: WebhookEndpointRecord = {
      id: deps.randomId("wh"),
      merchant,
      url,
      enabled,
      events,
      secret: deps.createSecret(),
      createdAt: now,
      updatedAt: now,
    };
    await mutatePayStoreBlob((store) => {
      // Phase 13 (P1-03): per-merchant endpoint ceiling. Throwing here aborts before the write.
      const owned = Object.values(section(store).endpoints)
        .map(asEndpoint)
        .filter((existing): existing is WebhookEndpointRecord => !!existing && sameMerchant(existing, merchant)).length;
      if (owned >= MAX_WEBHOOK_ENDPOINTS_PER_MERCHANT) {
        throw new WebhookHttpError(409, LIMIT_EXCEEDED_CODE, "Webhook endpoint limit reached for this merchant.");
      }
      section(store).endpoints[row.id] = row;
    });
    return { status: 200, body: { ...toPublicEndpoint(row), secret: row.secret } };
  } catch (err) {
    return asWebhookError(err);
  }
}

export async function listWebhookEndpoints(
  merchantRaw: unknown,
  deps: WebhookDeps = defaultWebhookDeps(),
): Promise<{ status: number; body: { endpoints: WebhookEndpointPublic[] } | WebhookApiError["body"] }> {
  try {
    const merchant = bindMerchant(merchantRaw, deps, "not_found");
    const store = await readPayStoreBlob();
    const endpoints = Object.values(section(store).endpoints)
      .map(asEndpoint)
      .filter((row): row is WebhookEndpointRecord => !!row && sameMerchant(row, merchant))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(toPublicEndpoint);
    return { status: 200, body: { endpoints } };
  } catch (err) {
    return asWebhookError(err);
  }
}

export async function getWebhookEndpoint(
  id: string,
  merchantRaw: unknown,
  deps: WebhookDeps = defaultWebhookDeps(),
): Promise<{ status: number; body: WebhookEndpointPublic | WebhookApiError["body"] }> {
  try {
    const merchant = bindMerchant(merchantRaw, deps, "not_found");
    const row = await loadEndpoint(id);
    if (!row || !sameMerchant(row, merchant)) return notFound();
    return { status: 200, body: toPublicEndpoint(row) };
  } catch (err) {
    return asWebhookError(err);
  }
}

export async function updateWebhookEndpoint(
  id: string,
  input: { merchant: unknown; url?: unknown; events?: unknown; enabled?: unknown; rotateSecret?: unknown },
  deps: WebhookDeps = defaultWebhookDeps(),
): Promise<{ status: number; body: (WebhookEndpointPublic & { secret?: string }) | WebhookApiError["body"] }> {
  try {
    const merchant = bindMerchant(input.merchant, deps, "not_found");
    // Validate URL/events before CAS so retries reuse the same secret/fields.
    let nextUrl: string | undefined;
    if (input.url !== undefined) {
      if (typeof input.url !== "string") {
        return webhookApiError(400, WEBHOOK_ERROR_CODES.invalidUrl, "Webhook URL must be an absolute https URL.");
      }
      nextUrl = validateWebhookUrl(input.url);
    }
    let nextEvents: WebhookEndpointRecord["events"] | undefined;
    if (input.events !== undefined) nextEvents = parseEventSubscriptions(input.events);
    const rotate = input.rotateSecret === true;
    const rotatedSecret = rotate ? deps.createSecret() : null;
    let updated: WebhookEndpointRecord | null = null;
    await mutatePayStoreBlob((store) => {
      const current = asEndpoint(section(store).endpoints[id]);
      // Delete wins: a concurrent delete leaves the endpoint missing.
      if (!current || !sameMerchant(current, merchant)) {
        throw new WebhookHttpError(404, WEBHOOK_ERROR_CODES.notFound, "Webhook endpoint not found.");
      }
      updated = {
        ...current,
        url: nextUrl ?? current.url,
        events: nextEvents ?? current.events,
        enabled: input.enabled === undefined ? current.enabled : Boolean(input.enabled),
        secret: rotatedSecret ?? current.secret,
        updatedAt: new Date(deps.nowSeconds() * 1000).toISOString(),
      };
      section(store).endpoints[id] = updated;
    });
    if (!updated) return notFound();
    const body: WebhookEndpointPublic & { secret?: string } = toPublicEndpoint(updated);
    if (rotate && rotatedSecret) body.secret = rotatedSecret;
    return { status: 200, body };
  } catch (err) {
    return asWebhookError(err);
  }
}

export async function deleteWebhookEndpoint(
  id: string,
  merchantRaw: unknown,
  deps: WebhookDeps = defaultWebhookDeps(),
): Promise<{ status: number; body: { deleted: true } | WebhookApiError["body"] }> {
  try {
    const merchant = bindMerchant(merchantRaw, deps, "not_found");
    await mutatePayStoreBlob((store) => {
      const current = asEndpoint(section(store).endpoints[id]);
      if (!current || !sameMerchant(current, merchant)) {
        throw new WebhookHttpError(404, WEBHOOK_ERROR_CODES.notFound, "Webhook endpoint not found.");
      }
      delete section(store).endpoints[id];
    });
    return { status: 200, body: { deleted: true } };
  } catch (err) {
    return asWebhookError(err);
  }
}

export async function listWebhookDeliveries(
  id: string,
  merchantRaw: unknown,
  deps: WebhookDeps = defaultWebhookDeps(),
): Promise<{ status: number; body: { deliveries: WebhookDeliveryPublic[] } | WebhookApiError["body"] }> {
  try {
    const merchant = bindMerchant(merchantRaw, deps, "not_found");
    const store = await readPayStoreBlob();
    const endpoint = asEndpoint(section(store).endpoints[id]);
    if (!endpoint || !sameMerchant(endpoint, merchant)) return notFound();
    const needle = merchant.toLowerCase();
    const deliveries = Object.values(section(store).deliveries)
      .map(asDelivery)
      .filter(
        (row): row is WebhookDeliveryRecord =>
          !!row && row.webhookId === id && row.merchant.toLowerCase() === needle,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.attempt - a.attempt))
      .slice(0, 100)
      .map(toPublicDelivery);
    return { status: 200, body: { deliveries } };
  } catch (err) {
    return asWebhookError(err);
  }
}

function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function leaseActive(row: WebhookDeliveryRecord, nowSeconds: number): boolean {
  if (!row.leaseOwner || !row.leaseExpiresAt) return false;
  const at = Date.parse(row.leaseExpiresAt);
  return !Number.isNaN(at) && at / 1000 > nowSeconds;
}

/** Due = pending/retrying schedule ready and not under an unexpired lease. */
export function isWebhookDeliveryDue(row: WebhookDeliveryRecord, nowSeconds: number): boolean {
  if (leaseActive(row, nowSeconds)) return false;
  if (row.status === "pending") {
    if (!row.nextRetryAt) return true;
    const at = Date.parse(row.nextRetryAt);
    return !Number.isNaN(at) && at / 1000 <= nowSeconds;
  }
  if (row.status === "retrying" && row.nextRetryAt) {
    const at = Date.parse(row.nextRetryAt);
    return !Number.isNaN(at) && at / 1000 <= nowSeconds;
  }
  return false;
}

/**
 * Classify an HTTP/network outcome.
 * Retry: 408, 429, 5xx, network, timeout. Other 4xx are permanent.
 */
export function classifyWebhookAttempt(
  httpStatus: number | null,
  networkError: boolean,
): "success" | "retryable" | "permanent" {
  if (networkError || httpStatus == null) return "retryable";
  if (httpStatus >= 200 && httpStatus < 300) return "success";
  if (httpStatus === 408 || httpStatus === 429) return "retryable";
  if (httpStatus >= 500 && httpStatus <= 599) return "retryable";
  return "permanent";
}

function hasDeliveryForEventEndpoint(
  sectionData: WebhookStoreSection,
  eventId: string,
  webhookId: string,
  attempt: number,
): boolean {
  for (const value of Object.values(sectionData.deliveries)) {
    const row = asDelivery(value);
    if (!row) continue;
    if (row.eventId !== eventId || row.webhookId !== webhookId) continue;
    if (attempt === 1) return true;
    if (row.attempt === attempt) return true;
  }
  return false;
}

/**
 * Durable enqueue before any HTTP. Returns null when a duplicate event+endpoint
 * (attempt 1) or same attempt already exists. Never performs HTTP.
 */
export async function enqueuePendingDelivery(input: {
  endpoint: WebhookEndpointRecord;
  envelope: WebhookEnvelope;
  rawBody: string;
  attempt: number;
  nextRetryAt: string | null;
  deps: WebhookDeps;
}): Promise<WebhookDeliveryRecord | null> {
  const deliveryId = input.deps.randomId("dlv");
  const createdAt = isoFromSeconds(input.deps.nowSeconds());
  const row: WebhookDeliveryRecord = {
    deliveryId,
    eventId: input.envelope.id,
    eventType: input.envelope.type,
    webhookId: input.endpoint.id,
    merchant: input.endpoint.merchant,
    attempt: input.attempt,
    status: "pending",
    httpStatus: null,
    createdAt,
    attemptedAt: null,
    nextRetryAt: input.nextRetryAt,
    error: null,
    body: input.rawBody,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
  let inserted: WebhookDeliveryRecord | null = null;
  await mutatePayStoreBlob((store) => {
    inserted = null; // reset on every CAS attempt
    const wh = section(store);
    if (hasDeliveryForEventEndpoint(wh, row.eventId, row.webhookId, row.attempt)) {
      return;
    }
    wh.deliveries[row.deliveryId] = row;
    pruneDeliveries(wh, row.webhookId);
    inserted = row;
  });
  return inserted;
}

async function findDelivery(
  eventId: string,
  webhookId: string,
  attempt: number,
): Promise<WebhookDeliveryRecord | null> {
  const store = await readPayStoreBlob();
  for (const value of Object.values(section(store).deliveries)) {
    const row = asDelivery(value);
    if (row && row.eventId === eventId && row.webhookId === webhookId && row.attempt === attempt) {
      return row;
    }
  }
  return null;
}

/**
 * Atomic claim with bounded lease + unpredictable ownership token.
 * Does not perform HTTP. Holds no lock across the network call.
 */
export async function claimDelivery(
  deliveryId: string,
  deps: WebhookDeps,
): Promise<{ row: WebhookDeliveryRecord; token: string } | null> {
  const token = deps.randomId("lease");
  const now = deps.nowSeconds();
  const leaseExpiresAt = isoFromSeconds(now + WEBHOOK_CLAIM_LEASE_SECONDS);
  let claimed: WebhookDeliveryRecord | null = null;
  await mutatePayStoreBlob((store) => {
    claimed = null; // reset on every CAS attempt so a lost race cannot stick
    const current = asDelivery(section(store).deliveries[deliveryId]);
    if (!current || !isWebhookDeliveryDue(current, now)) return;
    const next: WebhookDeliveryRecord = {
      ...current,
      leaseOwner: token,
      leaseExpiresAt,
    };
    section(store).deliveries[deliveryId] = next;
    claimed = next;
  });
  return claimed ? { row: claimed, token } : null;
}

/** Finalize only when the caller still owns the lease. Stale workers are rejected. */
export async function finalizeClaimedDelivery(
  deliveryId: string,
  token: string,
  patch: Partial<
    Pick<
      WebhookDeliveryRecord,
      "status" | "httpStatus" | "attemptedAt" | "nextRetryAt" | "error" | "attempt"
    >
  >,
): Promise<WebhookDeliveryRecord | null> {
  let out: WebhookDeliveryRecord | null = null;
  await mutatePayStoreBlob((store) => {
    out = null; // reset on every CAS attempt
    const current = asDelivery(section(store).deliveries[deliveryId]);
    if (!current || current.leaseOwner !== token) return;
    out = {
      ...current,
      ...patch,
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    section(store).deliveries[deliveryId] = out;
  });
  return out;
}


async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((row) => row.address);
}

/**
 * Resolve hostname and reject if any address is private/metadata.
 * Fail closed when DNS is unavailable. Does not pin the subsequent TCP connect
 * (Node fetch residual — see validateWebhookUrl docs).
 */
export async function assertSafeWebhookDestination(
  rawUrl: string,
  resolveHost: (hostname: string) => Promise<string[]> = defaultResolveHost,
): Promise<void> {
  const url = new URL(validateWebhookUrl(rawUrl));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedIp(host)) {
    throw new WebhookValidationError(WEBHOOK_ERROR_CODES.invalidUrl, "Webhook URL host is not allowed.");
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return;
  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    throw new WebhookValidationError(WEBHOOK_ERROR_CODES.invalidUrl, "Webhook URL host could not be resolved.");
  }
  if (!addresses.length) {
    throw new WebhookValidationError(WEBHOOK_ERROR_CODES.invalidUrl, "Webhook URL host could not be resolved.");
  }
  for (const address of addresses) {
    if (isBlockedIp(address)) {
      throw new WebhookValidationError(WEBHOOK_ERROR_CODES.invalidUrl, "Webhook URL host is not allowed.");
    }
  }
}

async function httpDeliver(
  endpoint: WebhookEndpointRecord,
  envelope: WebhookEnvelope,
  rawBody: string,
  deps: WebhookDeps,
): Promise<{ httpStatus: number | null; error: string | null; networkError: boolean }> {
  const timestamp = deps.nowSeconds();
  const signature = signWebhookBody(endpoint.secret, timestamp, rawBody);
  try {
    await assertSafeWebhookDestination(endpoint.url, deps.resolveHost ?? defaultResolveHost);
    const res = await deps.fetch(endpoint.url, {
      method: "POST",
      headers: {
        [WEBHOOK_HEADERS.contentType]: "application/json",
        [WEBHOOK_HEADERS.id]: envelope.id,
        [WEBHOOK_HEADERS.timestamp]: String(timestamp),
        [WEBHOOK_HEADERS.signature]: signature,
      },
      body: rawBody,
      redirect: "error",
    });
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    if (res.status >= 200 && res.status < 300) {
      return { httpStatus: res.status, error: null, networkError: false };
    }
    return { httpStatus: res.status, error: `HTTP ${res.status}`, networkError: false };
  } catch (err) {
    if (err instanceof WebhookValidationError) {
      return { httpStatus: null, error: err.message, networkError: false };
    }
    return { httpStatus: null, error: "network_error", networkError: true };
  }
}

/**
 * Persist intent (if needed), claim, HTTP outside CAS, finalize under lease.
 * At-least-once: consumers must deduplicate by eventId.
 */
async function deliverOnce(
  endpoint: WebhookEndpointRecord,
  envelope: WebhookEnvelope,
  rawBody: string,
  attempt: number,
  deps: WebhookDeps,
  existing?: WebhookDeliveryRecord | null,
): Promise<WebhookDeliveryRecord> {
  let row = existing ?? null;
  if (!row) {
    row = await enqueuePendingDelivery({
      endpoint,
      envelope,
      rawBody,
      attempt,
      nextRetryAt: null,
      deps,
    });
    if (!row) {
      const prior = await findDelivery(envelope.id, endpoint.id, attempt);
      if (prior) return prior;
      throw new Error("Webhook enqueue failed.");
    }
  }

  const claimed = await claimDelivery(row.deliveryId, deps);
  if (!claimed) {
    const store = await readPayStoreBlob();
    return asDelivery(section(store).deliveries[row.deliveryId]) ?? row;
  }

  const live = await loadEndpoint(endpoint.id);
  if (!live || !live.enabled) {
    const failed =
      (await finalizeClaimedDelivery(claimed.row.deliveryId, claimed.token, {
        status: "failed",
        httpStatus: null,
        attemptedAt: isoFromSeconds(deps.nowSeconds()),
        nextRetryAt: null,
        error: "endpoint_unavailable",
      })) ?? claimed.row;
    return failed;
  }

  // HTTP is outside CAS / lease mutation. Lease covers crash recovery only.
  const result = await httpDeliver(live, envelope, rawBody, deps);
  const kind = classifyWebhookAttempt(result.httpStatus, result.networkError);
  const attemptedAt = isoFromSeconds(deps.nowSeconds());
  let status: WebhookDeliveryStatus = "failed";
  let nextRetryAt: string | null = null;
  if (kind === "success") {
    status = "success";
  } else if (kind === "retryable") {
    const delay = retryDelaySeconds(attempt);
    if (delay != null) {
      status = "retrying";
      nextRetryAt = isoFromSeconds(deps.nowSeconds() + delay);
    } else {
      status = "failed";
    }
  } else {
    status = "failed";
  }

  const finalized =
    (await finalizeClaimedDelivery(claimed.row.deliveryId, claimed.token, {
      status,
      httpStatus: result.httpStatus,
      attemptedAt,
      nextRetryAt,
      error: result.error,
    })) ?? {
      ...claimed.row,
      status,
      httpStatus: result.httpStatus,
      attemptedAt,
      nextRetryAt,
      error: result.error,
      leaseOwner: null,
      leaseExpiresAt: null,
    };
  return finalized;
}

/**
 * Domain emit. Never throws to callers who use safeEmitWebhookEvent.
 * Does not emit payment.* or payment_request.expired.
 * Durable: each matching endpoint gets a persisted pending row before HTTP.
 */
export async function emitWebhookEvent(
  input: {
    type: EmittableWebhookEvent;
    merchant: Address | string;
    data: Record<string, unknown>;
  },
  deps: WebhookDeps = defaultWebhookDeps(),
): Promise<{ eventId: string; deliveries: WebhookDeliveryRecord[] }> {
  assertEmittableEvent(input.type);
  const merchant = parseMerchantAddress(input.merchant);
  const envelope: WebhookEnvelope = {
    id: deps.randomId("evt"),
    type: input.type,
    createdAt: isoFromSeconds(deps.nowSeconds()),
    merchant,
    data: input.data,
  };
  const rawBody = envelopeJson(envelope);
  const store = await readPayStoreBlob();
  const endpoints = Object.values(section(store).endpoints)
    .map(asEndpoint)
    .filter(
      (row): row is WebhookEndpointRecord =>
        !!row &&
        row.enabled &&
        sameMerchant(row, merchant) &&
        row.events.includes(input.type),
    );
  const deliveries: WebhookDeliveryRecord[] = [];
  for (const endpoint of endpoints) {
    deliveries.push(await deliverOnce(endpoint, envelope, rawBody, 1, deps));
  }
  return { eventId: envelope.id, deliveries };
}

/** Fire-and-forget. Failures never reject. Never changes payment state. */
export function safeEmitWebhookEvent(
  input: {
    type: EmittableWebhookEvent;
    merchant: Address | string;
    data: Record<string, unknown>;
  },
  deps?: WebhookDeps,
): void {
  void emitWebhookEvent(input, deps).catch((err) => {
    /* webhook delivery is downstream notification only */
    safeLog("warn", "webhook_emit_failed", {
      type: input.type,
      merchant: String(input.merchant),
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export async function sendWebhookTest(
  id: string,
  merchantRaw: unknown,
  deps: WebhookDeps = defaultWebhookDeps(),
): Promise<{ status: number; body: { eventId: string; delivery: WebhookDeliveryPublic } | WebhookApiError["body"] }> {
  try {
    const merchant = bindMerchant(merchantRaw, deps, "not_found");
    const endpoint = await loadEndpoint(id);
    if (!endpoint || !sameMerchant(endpoint, merchant)) return notFound();
    validateWebhookUrl(endpoint.url);
    const envelope: WebhookEnvelope = {
      id: deps.randomId("evt"),
      type: "webhook.test",
      createdAt: isoFromSeconds(deps.nowSeconds()),
      merchant,
      data: {
        webhookId: endpoint.id,
        message: "FINAL webhook test event. This is not a payment event.",
      },
    };
    const delivery = await deliverOnce(endpoint, envelope, envelopeJson(envelope), 1, deps);
    return { status: 200, body: { eventId: envelope.id, delivery: toPublicDelivery(delivery) } };
  } catch (err) {
    return asWebhookError(err);
  }
}

/**
 * Process due deliveries with atomic claim/lease.
 * At-least-once HTTP: consumers must deduplicate by eventId.
 * Wire via GET /api/cron/webhooks with CRON_SECRET (fail-closed when unset).
 */
export async function processDueWebhookDeliveries(
  deps: WebhookDeps = defaultWebhookDeps(),
): Promise<WebhookDeliveryRecord[]> {
  const store = await readPayStoreBlob();
  const now = deps.nowSeconds();
  const due = Object.values(section(store).deliveries)
    .map(asDelivery)
    .filter((row): row is WebhookDeliveryRecord => !!row && isWebhookDeliveryDue(row, now))
    .sort((a, b) => {
      const aAt = a.nextRetryAt ?? a.createdAt;
      const bAt = b.nextRetryAt ?? b.createdAt;
      return aAt < bAt ? -1 : aAt > bAt ? 1 : 0;
    })
    .slice(0, WEBHOOK_MAX_DUE_PER_RUN);

  const out: WebhookDeliveryRecord[] = [];
  for (const prior of due) {
    if (prior.status === "pending") {
      const endpoint = asEndpoint(section(store).endpoints[prior.webhookId]) ?? (await loadEndpoint(prior.webhookId));
      if (!endpoint) {
        const claimed = await claimDelivery(prior.deliveryId, deps);
        if (claimed) {
          const failed = await finalizeClaimedDelivery(claimed.row.deliveryId, claimed.token, {
            status: "failed",
            nextRetryAt: null,
            error: "endpoint_unavailable",
            attemptedAt: isoFromSeconds(deps.nowSeconds()),
          });
          if (failed) out.push(failed);
        }
        continue;
      }
      let envelope: WebhookEnvelope;
      try {
        envelope = JSON.parse(prior.body) as WebhookEnvelope;
      } catch {
        const claimed = await claimDelivery(prior.deliveryId, deps);
        if (claimed) {
          await finalizeClaimedDelivery(claimed.row.deliveryId, claimed.token, {
            status: "failed",
            nextRetryAt: null,
            error: "invalid_body",
            attemptedAt: isoFromSeconds(deps.nowSeconds()),
          });
        }
        continue;
      }
      out.push(await deliverOnce(endpoint, envelope, prior.body, prior.attempt, deps, prior));
      continue;
    }

    // status === "retrying" with due nextRetryAt
    const claimed = await claimDelivery(prior.deliveryId, deps);
    if (!claimed) continue;

    const endpoint = (await loadEndpoint(prior.webhookId)) ?? asEndpoint(section(store).endpoints[prior.webhookId]);
    if (!endpoint || !endpoint.enabled) {
      const failed = await finalizeClaimedDelivery(claimed.row.deliveryId, claimed.token, {
        status: "failed",
        nextRetryAt: null,
        error: "endpoint_unavailable",
      });
      if (failed) out.push(failed);
      continue;
    }

    let envelope: WebhookEnvelope;
    try {
      envelope = JSON.parse(prior.body) as WebhookEnvelope;
    } catch {
      await finalizeClaimedDelivery(claimed.row.deliveryId, claimed.token, {
        status: "failed",
        nextRetryAt: null,
        error: "invalid_body",
      });
      continue;
    }

    const nextAttempt = prior.attempt + 1;
    if (nextAttempt > WEBHOOK_MAX_ATTEMPTS) {
      await finalizeClaimedDelivery(claimed.row.deliveryId, claimed.token, {
        status: "failed",
        nextRetryAt: null,
      });
      continue;
    }

    // Consume this schedule slot so another worker cannot fire the same attempt.
    await finalizeClaimedDelivery(claimed.row.deliveryId, claimed.token, {
      status: prior.attempt >= WEBHOOK_MAX_ATTEMPTS ? "failed" : "retrying",
      nextRetryAt: null,
      error: prior.error,
    });

    out.push(await deliverOnce(endpoint, envelope, prior.body, nextAttempt, deps));
  }
  return out;
}

/**
 * Cron auth: Bearer CRON_SECRET only. Fail-closed when missing/short.
 * Merchant API keys are never accepted as cron credentials.
 */
export function authorizeWebhookCron(request: Request): {
  ok: true;
} | {
  ok: false;
  status: number;
  body: { error: { code: string; message: string } };
} {
  const secret = process.env.CRON_SECRET;
  if (typeof secret !== "string" || secret.length < 16) {
    return {
      ok: false,
      status: 503,
      body: {
        error: {
          code: "cron_not_configured",
          message: "CRON_SECRET is not configured.",
        },
      },
    };
  }
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return {
      ok: false,
      status: 401,
      body: {
        error: {
          code: "unauthorized",
          message: "Invalid cron authorization.",
        },
      },
    };
  }
  return { ok: true };
}

function asWebhookError(err: unknown): WebhookApiError {
  if (err instanceof WebhookHttpError) {
    return webhookApiError(err.status, err.code, err.message);
  }
  if (err instanceof WebhookValidationError) {
    return webhookApiError(400, err.code, err.message);
  }
  if (err instanceof Error && /store|Payment store/i.test(err.message)) {
    return webhookApiError(503, WEBHOOK_ERROR_CODES.storeUnavailable, "Payment store is unavailable.");
  }
  return webhookApiError(500, WEBHOOK_ERROR_CODES.internal, "Something went wrong.");
}

/** Emit payment_request.created for a newly stored row. Safe no-op on failure. */
export function emitPaymentRequestCreated(row: PayRecord, deps?: WebhookDeps): void {
  safeEmitWebhookEvent(
    {
      type: "payment_request.created",
      merchant: row.to,
      data: paymentRequestEventData(row),
    },
    deps,
  );
}

/** Emit payment_request.cancelled after a successful cancel. Safe no-op on failure. */
export function emitPaymentRequestCancelled(row: PayRecord, deps?: WebhookDeps): void {
  safeEmitWebhookEvent(
    {
      type: "payment_request.cancelled",
      merchant: row.to,
      data: paymentRequestEventData(row),
    },
    deps,
  );
}
