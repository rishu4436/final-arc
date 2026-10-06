import { getAddress, isAddress, type Address } from "viem";
import { authorizeHttp, type ApiErrorResult } from "./apiKeys";
import { WALLET_ACTIONS, type ApiScope, type WalletAction } from "./apiScopes";
import { verifyFinalRequest, type FinalRequest } from "./finalRequest";
import { loadMemoLedger, type LedgerEntry } from "./ledger";
import { findSettlementProof, lookupFromRecord, payRecordIdentity, type PaidLookup, type PayIdentity } from "./payPaid";
import { decodePayLink } from "./payRequest";
import {
  createPayRecord,
  getRecord,
  listByPayee,
  markCancelled,
  markPaid,
  markViewed,
  upsertRecord,
  type CancelCommand,
  type PaidProof,
  type PayRecord,
} from "./payStore";
import {
  RATE_LIMITED_MESSAGE,
  legacyRateLimiter,
  requestClientKey,
  type LegacyRouteClass,
} from "./publicRateLimit";
import { PAYMENT_STATUS_UNAVAILABLE, reconcilePaymentRecord } from "./reconcilePayment";
import { resolveCancellation } from "./resolveCancellation";
import {
  LIMIT_EXCEEDED_CODE,
  ResourceLimitExceededError,
  ownsPayRecord,
} from "./resourceLimits";
import { emitPaymentRequestCancelled, emitPaymentRequestCreated } from "./webhooks";

/**
 * Legacy /api/pay and /api/statement.
 *
 * Phase 13 boundary (P1-03 / P1-04 / P1-05). This module decides WHO may reach
 * the reconciliation helper and which public calls may write. It does not
 * change HOW reconciliation decides payment state: reconcilePaymentRecord,
 * findSettlementProof, markPaid, and resolveCancellation are called unchanged.
 *
 * - Public observation is not merchant record creation. GET ?token= and the
 *   "view" action never create a row.
 * - V2 registration requires the existing canonical EIP-712 check
 *   (verifyFinalRequest). The owner is the signed merchant.
 * - V1 links are unsigned. V1 registration requires merchant authentication
 *   (wallet "payments.register" or an API key with payment_requests:write)
 *   for the link's payee.
 * - GET ?to= and /api/statement require merchant authentication
 *   (wallet "payments.read" or payment_requests:read) and the authenticated
 *   merchant must equal the requested address, else 404.
 * - The legacy per-link webhookUrl is retired. It is not accepted, not
 *   overwritten, never fetched, and never returned.
 * - Expensive public entry points are rate limited per process
 *   (see publicRateLimit.ts; not distributed).
 */

export type LegacyErrorBody = { error: string; code?: string };

export type PayHttpResult = {
  status: number;
  body: { record: PayRecord } | { records: PayRecord[] } | LegacyErrorBody;
};

export type StatementHttpResult = {
  status: number;
  body: { payments: LedgerEntry[]; links: PayRecord[] } | LegacyErrorBody;
};

export type LegacyAuthorize = (
  request: Request,
  opts: { scope: ApiScope; walletAction: WalletAction },
) => Promise<{ ok: true; merchant: Address } | ApiErrorResult>;

export type PayStatusDeps = {
  getRecord: (token: string) => Promise<PayRecord | null>;
  listByPayee: (to: Address) => Promise<PayRecord[]>;
  markCancelled: (token: string, command: CancelCommand) => Promise<PayRecord | null>;
  markPaid: (token: string, proof: PaidProof) => Promise<PayRecord | null>;
  markViewed: (token: string) => Promise<PayRecord | null>;
  upsertRecord: (record: PayRecord) => Promise<PayRecord>;
  /**
   * Atomic create-or-merge with per-merchant create cap on the CAS snapshot.
   * Updating an existing token must not consume create capacity.
   */
  createOwnedRecord: (record: PayRecord, owner: Address) => Promise<{ record: PayRecord; created: boolean }>;
  findSettlementProof: (lookup: PaidLookup) => Promise<PaidProof | null>;
  loadMemoLedger: (account: Address) => Promise<LedgerEntry[]>;
  /** Existing authorizeHttp (API key or wallet-signed headers). Never a query/body merchant. */
  authorize: LegacyAuthorize;
  /** Process-local limiter. True when allowed. */
  rateLimit: (routeClass: LegacyRouteClass, key: string) => boolean;
  /** Rate-limit identity for unauthenticated callers. Must not trust spoofable headers. */
  clientKey: (request: Request) => string;
  /** Canonical V2 signature check. Defaults to verifyFinalRequest. */
  verifyV2Request?: (request: FinalRequest) => Promise<boolean>;
  /** Phase 4 webhook emitters. Default to the real emitters. */
  emitCreated?: (row: PayRecord) => void;
  emitCancelled?: (row: PayRecord) => void;
};

type PostBody = {
  token?: unknown;
  action?: unknown;
  address?: unknown;
  signature?: unknown;
};

const SMUGGLED_KEY_PARAMS = ["api_key", "apiKey", "key"];

function fail(status: number, error: string, code?: string): { status: number; body: LegacyErrorBody } {
  return { status, body: code ? { error, code } : { error } };
}

function unavailable(): { status: number; body: LegacyErrorBody } {
  return { status: 503, body: { error: PAYMENT_STATUS_UNAVAILABLE } };
}

function rateLimited(): { status: number; body: LegacyErrorBody } {
  return fail(429, RATE_LIMITED_MESSAGE, "rate_limited");
}

/** Same answer for "not yours" and "does not exist". */
function notFound(): { status: number; body: LegacyErrorBody } {
  return fail(404, "Not found.", "not_found");
}

function fromApiError(result: ApiErrorResult): { status: number; body: LegacyErrorBody } {
  return fail(result.status, result.body.error.message, result.body.error.code);
}

/**
 * The retired legacy webhookUrl is never returned. Stored values are kept
 * (not deleted automatically) but are inert.
 */
export function publicPayRecord(row: PayRecord): PayRecord {
  return { ...row, webhookUrl: null };
}

function blankRecord(token: string, identity: PayIdentity): PayRecord {
  return {
    token,
    id: identity.id,
    to: identity.to,
    amount: identity.amount,
    memo: identity.memo,
    createdAt: new Date().toISOString(),
    views: 0,
    lastViewedAt: null,
    cancelled: false,
    cancelledAt: null,
    paidTx: null,
    // Retired. New rows never carry a legacy webhook URL.
    webhookUrl: null,
  };
}

function tokenFrom(body: PostBody | null): string | null {
  if (typeof body?.token !== "string") return null;
  const token = body.token.trim();
  return token || null;
}

function smuggledKey(url: URL): boolean {
  return SMUGGLED_KEY_PARAMS.some((name) => url.searchParams.has(name));
}

/** Reconciliation is called unchanged. The legacy paid notification is retired, so no notifyPaid port. */
async function withPaid(row: PayRecord, deps: PayStatusDeps): Promise<PayRecord> {
  return reconcilePaymentRecord(row, {
    findSettlementProof: deps.findSettlementProof,
    markPaid: deps.markPaid,
  });
}

/**
 * Authenticated merchant must equal the requested address.
 * The address in the query is a filter, never the source of authority.
 */
async function authorizeMerchantRead(
  request: Request,
  requested: Address,
  deps: PayStatusDeps,
): Promise<{ ok: true; merchant: Address } | { ok: false; result: { status: number; body: LegacyErrorBody } }> {
  const auth = await deps.authorize(request, {
    scope: "payment_requests:read",
    walletAction: WALLET_ACTIONS.paymentsRead,
  });
  if (!("merchant" in auth)) return { ok: false, result: fromApiError(auth) };
  if (getAddress(auth.merchant) !== requested) return { ok: false, result: notFound() };
  return { ok: true, merchant: getAddress(auth.merchant) };
}

async function payGetInner(request: Request, deps: PayStatusDeps): Promise<PayHttpResult> {
  const url = new URL(request.url);
  if (smuggledKey(url)) return fail(401, "API authentication required", "unauthorized");
  const token = url.searchParams.get("token");
  const toValues = url.searchParams.getAll("to");

  if (token) {
    if (!deps.rateLimit("pay.token_read", deps.clientKey(request))) return rateLimited();
    // Public by token. Never creates a row: an unknown token is 404, not a new record.
    const row = await deps.getRecord(token);
    if (!row) return { status: 404, body: { error: "Unknown payment." } };
    const next = await withPaid(row, deps);
    return { status: 200, body: { record: publicPayRecord(next) } };
  }

  if (toValues.length > 1) return fail(400, "Only one to address is allowed.", "invalid_request");
  const to = toValues[0];
  if (to && isAddress(to)) {
    if (!deps.rateLimit("pay.list_ip", deps.clientKey(request))) return rateLimited();
    const requested = getAddress(to);
    const auth = await authorizeMerchantRead(request, requested, deps);
    if (!auth.ok) return auth.result;
    if (!deps.rateLimit("pay.list_merchant", `merchant:${auth.merchant}`)) return rateLimited();
    const rows = (await deps.listByPayee(auth.merchant)).filter((row) => ownsPayRecord(row, auth.merchant));
    const records = await Promise.all(rows.map((row) => withPaid(row, deps)));
    return { status: 200, body: { records: records.map(publicPayRecord) } };
  }

  return { status: 400, body: { error: "token or to required" } };
}

async function registerInner(
  request: Request,
  token: string,
  identity: PayIdentity,
  deps: PayStatusDeps,
): Promise<PayHttpResult> {
  let owner: Address;
  if (identity.version === 2) {
    const link = decodePayLink(token);
    if (!link || link.version !== 2) return fail(400, "Invalid payment link.", "invalid_request");
    const verify = deps.verifyV2Request ?? verifyFinalRequest;
    // Existing canonical EIP-712 check: the signature must recover to request.merchant.
    if (!(await verify(link.request))) {
      return fail(400, "Payment request signature is invalid.", "invalid_signature");
    }
    owner = getAddress(link.request.merchant);
  } else {
    // V1 is unsigned. Only the authenticated payee may register it.
    const auth = await deps.authorize(request, {
      scope: "payment_requests:write",
      walletAction: WALLET_ACTIONS.paymentsRegister,
    });
    if (!("merchant" in auth)) return fromApiError(auth);
    if (getAddress(auth.merchant) !== getAddress(identity.to)) {
      return fail(403, "Merchant does not match this payment link.", "forbidden");
    }
    owner = getAddress(auth.merchant);
  }

  const existing = await deps.getRecord(token);
  if (existing) {
    // Idempotent. No write, no webhook, no settlement scan, no field overwrite.
    return { status: 200, body: { record: publicPayRecord(existing) } };
  }

  let createdRow: PayRecord;
  let created: boolean;
  try {
    const result = await deps.createOwnedRecord(blankRecord(token, identity), owner);
    createdRow = result.record;
    created = result.created;
  } catch (err) {
    if (err instanceof ResourceLimitExceededError) {
      return fail(409, err.message, LIMIT_EXCEEDED_CODE);
    }
    throw err;
  }
  // payment_request.created is delivered to the payee's endpoints (Phase 4 semantics).
  // Emit only when the authenticated/signed owner is that payee, so a third party
  // cannot trigger webhooks on another merchant by naming them as recipient.
  if (created && getAddress(createdRow.to) === owner) {
    (deps.emitCreated ?? emitPaymentRequestCreated)(createdRow);
  }
  return { status: 200, body: { record: publicPayRecord(createdRow) } };
}

async function payPostInner(request: Request, body: PostBody, deps: PayStatusDeps): Promise<PayHttpResult> {
  const token = tokenFrom(body);
  if (!token) return { status: 400, body: { error: "token required" } };
  const identity = payRecordIdentity(token);
  if (!identity) return { status: 400, body: { error: "Invalid payment link." } };

  const action = body.action ?? "register";

  if (action === "register") return registerInner(request, token, identity, deps);

  if (action === "view") {
    // Public. Counts a view on an EXISTING row only. Never creates a row,
    // never scans the chain, never sends a notification.
    const row = await deps.getRecord(token);
    if (!row) return { status: 404, body: { error: "Unknown payment." } };
    const next = (await deps.markViewed(token)) ?? row;
    return { status: 200, body: { record: publicPayRecord(next) } };
  }

  if (action === "cancel") {
    const lookup = lookupFromRecord({
      token,
      to: identity.to,
      amount: identity.amount,
      memo: identity.memo,
      cancelled: false,
    });
    const resolved = await resolveCancellation(
      {
        token,
        identity,
        lookup,
        address: typeof body.address === "string" ? body.address : undefined,
        signature: typeof body.signature === "string" ? body.signature : undefined,
        nowSeconds: Math.floor(Date.now() / 1000),
      },
      {
        getRecord: deps.getRecord,
        markPaid: deps.markPaid,
        markCancelled: deps.markCancelled,
        findSettlementProof: deps.findSettlementProof,
        ensureRecord: () => deps.upsertRecord(blankRecord(token, identity)),
      },
    );
    if (!resolved.ok) {
      return { status: resolved.status, body: { error: resolved.error } };
    }
    if (resolved.notify === "cancelled") (deps.emitCancelled ?? emitPaymentRequestCancelled)(resolved.record);
    return { status: 200, body: { record: publicPayRecord(resolved.record) } };
  }

  return { status: 400, body: { error: "Unknown action" } };
}

/** GET /api/pay. Infrastructure failures are 503, not an unpaid record. */
export async function payGet(request: Request, deps: PayStatusDeps): Promise<PayHttpResult> {
  try {
    return await payGetInner(request, deps);
  } catch {
    return unavailable();
  }
}

/** POST /api/pay. A thrown settlement or store call does not store a cancel and is not unpaid. */
export async function payPost(request: Request, deps: PayStatusDeps): Promise<PayHttpResult> {
  let body: PostBody;
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: 400, body: { error: "token required" } };
    }
    body = parsed as PostBody;
  } catch {
    return { status: 400, body: { error: "token required" } };
  }
  if (!deps.rateLimit("pay.write", deps.clientKey(request))) return rateLimited();
  try {
    return await payPostInner(request, body, deps);
  } catch {
    return unavailable();
  }
}

/** GET /api/statement. A ledger or settlement failure is 503, not a finished unpaid list. */
export async function statementGet(request: Request, deps: PayStatusDeps): Promise<StatementHttpResult> {
  const url = new URL(request.url);
  if (smuggledKey(url)) return fail(401, "API authentication required", "unauthorized");
  const addresses = url.searchParams.getAll("address");
  if (addresses.length > 1) return fail(400, "Only one address is allowed.", "invalid_request");
  const address = addresses[0];
  if (!address || !isAddress(address)) {
    return { status: 400, body: { error: "Valid address required." } };
  }
  const requested = getAddress(address);
  if (!deps.rateLimit("statement.ip", deps.clientKey(request))) return rateLimited();
  let account: Address;
  try {
    const auth = await authorizeMerchantRead(request, requested, deps);
    if (!auth.ok) return auth.result;
    account = auth.merchant;
  } catch {
    return unavailable();
  }
  if (!deps.rateLimit("statement.merchant", `merchant:${account}`)) return rateLimited();
  try {
    const payments = await deps.loadMemoLedger(account);
    const links = (await deps.listByPayee(account)).filter((row) => ownsPayRecord(row, account));
    const openLinks: PayRecord[] = [];
    for (const row of links) {
      openLinks.push(publicPayRecord(await withPaid(row, deps)));
    }
    return { status: 200, body: { payments, links: openLinks } };
  } catch {
    return unavailable();
  }
}

export const livePayStatusDeps: PayStatusDeps = {
  getRecord,
  listByPayee,
  markCancelled,
  markPaid,
  markViewed,
  upsertRecord,
  createOwnedRecord: createPayRecord,
  findSettlementProof,
  loadMemoLedger,
  authorize: (request, opts) => authorizeHttp(request, opts),
  rateLimit: (routeClass, key) => legacyRateLimiter.allow(routeClass, key),
  clientKey: (request) => requestClientKey(request),
};
