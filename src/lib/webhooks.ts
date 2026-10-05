import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, parseUnits, type Address } from "viem";
import { deriveMemoId } from "./finalRequest";
import { decodePayLink } from "./payRequest";
import { LIMIT_EXCEEDED_CODE, MAX_WEBHOOK_ENDPOINTS_PER_MERCHANT } from "./resourceLimits";
import {
  mutatePayStoreBlob,
  readPayStoreBlob,
  writePayStoreBlob,
  type PayRecord,
  type WebhookStoreSection,
} from "./payStore";

import {
  EMITTABLE_WEBHOOK_EVENTS,
  WEBHOOK_EVENT_CATALOG,
  WEBHOOK_HEADERS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_SECONDS,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  type EmittableWebhookEvent,
  type WebhookEventType,
} from "./webhooksCatalog";

export {
  EMITTABLE_WEBHOOK_EVENTS,
  WEBHOOK_EVENT_CATALOG,
  WEBHOOK_HEADERS,
  WEBHOOK_MAX_ATTEMPTS,
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

export type WebhookDeliveryStatus = "success" | "failed" | "retrying";

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
  if (row.status !== "success" && row.status !== "failed" && row.status !== "retrying") return null;
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
        signal: init.signal ?? AbortSignal.timeout(8000),
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
 * Absolute https URLs only. Rejects userinfo, localhost, private and link-local
 * IPv4, and common cloud metadata hosts. Hostname literals that are not IPs are
 * allowed (DNS rebinding is out of scope for this phase).
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
    host.endsWith(".localhost")
  ) {
    throw new WebhookValidationError(WEBHOOK_ERROR_CODES.invalidUrl, "Webhook URL host is not allowed.");
  }
  if (isBlockedIp(host)) {
    throw new WebhookValidationError(WEBHOOK_ERROR_CODES.invalidUrl, "Webhook URL host is not allowed.");
  }
  return url.toString();
}

function isBlockedIp(host: string): boolean {
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
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
    const store = await readPayStoreBlob();
    const current = asEndpoint(section(store).endpoints[id]);
    if (!current || !sameMerchant(current, merchant)) return notFound();

    let url = current.url;
    if (input.url !== undefined) {
      if (typeof input.url !== "string") {
        return webhookApiError(400, WEBHOOK_ERROR_CODES.invalidUrl, "Webhook URL must be an absolute https URL.");
      }
      url = validateWebhookUrl(input.url);
    }
    let events = current.events;
    if (input.events !== undefined) events = parseEventSubscriptions(input.events);
    const enabled = input.enabled === undefined ? current.enabled : Boolean(input.enabled);
    const rotate = input.rotateSecret === true;
    const secret = rotate ? deps.createSecret() : current.secret;
    const updated: WebhookEndpointRecord = {
      ...current,
      url,
      events,
      enabled,
      secret,
      updatedAt: new Date(deps.nowSeconds() * 1000).toISOString(),
    };
    section(store).endpoints[id] = updated;
    await writePayStoreBlob(store);
    const body: WebhookEndpointPublic & { secret?: string } = toPublicEndpoint(updated);
    if (rotate) body.secret = secret;
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
    const store = await readPayStoreBlob();
    const current = asEndpoint(section(store).endpoints[id]);
    if (!current || !sameMerchant(current, merchant)) return notFound();
    delete section(store).endpoints[id];
    await writePayStoreBlob(store);
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

async function persistDelivery(row: WebhookDeliveryRecord): Promise<void> {
  await mutatePayStoreBlob((store) => {
    const wh = section(store);
    wh.deliveries[row.deliveryId] = row;
    pruneDeliveries(wh, row.webhookId);
  });
}

async function deliverOnce(
  endpoint: WebhookEndpointRecord,
  envelope: WebhookEnvelope,
  rawBody: string,
  attempt: number,
  deps: WebhookDeps,
): Promise<WebhookDeliveryRecord> {
  const deliveryId = deps.randomId("dlv");
  const createdAt = new Date(deps.nowSeconds() * 1000).toISOString();
  const timestamp = deps.nowSeconds();
  const signature = signWebhookBody(endpoint.secret, timestamp, rawBody);
  const attemptedAt = new Date(deps.nowSeconds() * 1000).toISOString();
  let httpStatus: number | null = null;
  let error: string | null = null;
  let status: WebhookDeliveryStatus = "failed";
  try {
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
    httpStatus = res.status;
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    if (res.status >= 200 && res.status < 300) {
      status = "success";
    } else {
      error = `HTTP ${res.status}`;
    }
  } catch {
    error = "network_error";
  }

  let nextRetryAt: string | null = null;
  if (status !== "success") {
    const delay = retryDelaySeconds(attempt);
    if (delay != null) {
      status = "retrying";
      nextRetryAt = new Date((deps.nowSeconds() + delay) * 1000).toISOString();
    } else {
      status = "failed";
    }
  }

  const row: WebhookDeliveryRecord = {
    deliveryId,
    eventId: envelope.id,
    eventType: envelope.type,
    webhookId: endpoint.id,
    merchant: endpoint.merchant,
    attempt,
    status,
    httpStatus,
    createdAt,
    attemptedAt,
    nextRetryAt,
    error,
    body: rawBody,
  };
  await persistDelivery(row);
  return row;
}

/**
 * Domain emit. Never throws to callers who use safeEmitWebhookEvent.
 * Does not emit payment.* or payment_request.expired.
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
    createdAt: new Date(deps.nowSeconds() * 1000).toISOString(),
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
  void emitWebhookEvent(input, deps).catch(() => {
    /* webhook delivery is downstream notification only */
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
      createdAt: new Date(deps.nowSeconds() * 1000).toISOString(),
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
 * Process due retries. Same eventId, new deliveryId per attempt.
 * Not wired to a cron in this phase; callable for tests and a future worker.
 */
export async function processDueWebhookDeliveries(
  deps: WebhookDeps = defaultWebhookDeps(),
): Promise<WebhookDeliveryRecord[]> {
  const store = await readPayStoreBlob();
  const now = deps.nowSeconds();
  const due = Object.values(section(store).deliveries)
    .map(asDelivery)
    .filter((row): row is WebhookDeliveryRecord => {
      if (!row || row.status !== "retrying" || !row.nextRetryAt) return false;
      const at = Date.parse(row.nextRetryAt);
      return !Number.isNaN(at) && at / 1000 <= now;
    })
    .sort((a, b) => (a.nextRetryAt! < b.nextRetryAt! ? -1 : 1));

  const out: WebhookDeliveryRecord[] = [];
  for (const prior of due) {
    const endpoint = asEndpoint(section(store).endpoints[prior.webhookId]);
    if (!endpoint || !endpoint.enabled) {
      const failed: WebhookDeliveryRecord = {
        ...prior,
        status: "failed",
        nextRetryAt: null,
        error: prior.error ?? "endpoint_unavailable",
      };
      section(store).deliveries[prior.deliveryId] = failed;
      continue;
    }
    let envelope: WebhookEnvelope;
    try {
      envelope = JSON.parse(prior.body) as WebhookEnvelope;
    } catch {
      continue;
    }
    // Mark prior slot consumed so a second processDue does not double-fire the same attempt.
    section(store).deliveries[prior.deliveryId] = {
      ...prior,
      status: prior.attempt >= WEBHOOK_MAX_ATTEMPTS ? "failed" : "retrying",
      nextRetryAt: null,
      error: prior.error,
    };
    await writePayStoreBlob(store);
    const nextAttempt = prior.attempt + 1;
    if (nextAttempt > WEBHOOK_MAX_ATTEMPTS) continue;
    out.push(await deliverOnce(endpoint, envelope, prior.body, nextAttempt, deps));
  }
  return out;
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
