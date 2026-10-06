import { createHash } from "node:crypto";
import { getAddress, isAddress, isHash, type Address, type Hash } from "viem";
import { authorizeHttp, type ApiErrorResult } from "./apiKeys";
import { WALLET_ACTIONS, type ApiScope, type WalletAction } from "./apiScopes";
import { verifyFinalRequest, type FinalRequest } from "./finalRequest";
import { loadMemoLedger, type LedgerEntry } from "./ledger";
import { findSettlementProof, lookupFromRecord, payRecordIdentity, type PaidLookup, type PayIdentity } from "./payPaid";
import { decodePayLink, encodeV2PayRequest } from "./payRequest";
import {
  DuplicateRequestError,
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
  legacyAllow,
  requestClientKey,
  type LegacyRouteClass,
} from "./publicRateLimit";
import { PAYMENT_STATUS_UNAVAILABLE } from "./reconcilePayment";
import { resolveCancellation } from "./resolveCancellation";
import {
  LIMIT_EXCEEDED_CODE,
  ResourceLimitExceededError,
  ownsPayRecord,
} from "./resourceLimits";
import { reconcileOnePayment, submitTransactionHash } from "./settlement";
import { emitPaymentRequestCancelled, emitPaymentRequestCreated } from "./webhooks";

/**
 * Legacy /api/pay and /api/statement.
 *
 * Phase 14: payment GETs are pure (no reconciliation, no markPaid).
 * Settlement is POST action=submit (public hash candidate) or
 * POST action=reconcile (authenticated single-row recovery).
 *
 * - Public observation is not merchant record creation. GET ?token= and the
 *   "view" action never create a row and never scan the chain.
 * - V2 registration requires verifyFinalRequest; tokens are stored canonical.
 * - V1 links are unsigned. V1 registration requires merchant authentication.
 * - GET ?to= and /api/statement require merchant authentication and return
 *   stored rows only (zero reconciliation RPC).
 * - The legacy per-link webhookUrl is retired.
 * - Cancel does not scan; payment-before-cancel is enforced at settle time.
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
  opts: { scope: ApiScope; walletAction: WalletAction; bodyText?: string },
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
  /** Rate limiter (process-local, plus shared Redis counter in production). True when allowed. */
  rateLimit: (routeClass: LegacyRouteClass, key: string) => boolean | Promise<boolean>;
  /** Rate-limit identity for unauthenticated callers. Must not trust spoofable headers. */
  clientKey: (request: Request) => string;
  /** Canonical V2 signature check. Defaults to verifyFinalRequest. */
  verifyV2Request?: (request: FinalRequest) => Promise<boolean>;
  /** Phase 4 webhook emitters. Default to the real emitters. */
  emitCreated?: (row: PayRecord) => void;
  emitCancelled?: (row: PayRecord) => void;
  /** Phase 14 settlement ports. Defaults to live settlement helpers. */
  submitHash?: typeof submitTransactionHash;
  reconcileOne?: typeof reconcileOnePayment;
};

type PostBody = {
  token?: unknown;
  action?: unknown;
  address?: unknown;
  signature?: unknown;
  /** Phase 14 submit / optional reconcile hint. */
  txHash?: unknown;
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

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function parseTxHash(value: unknown): Hash | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!isHash(trimmed)) return null;
  return trimmed.toLowerCase() as Hash;
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
    bodyText: "",
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
    if (!(await deps.rateLimit("pay.token_read", deps.clientKey(request)))) return rateLimited();
    // Public by token. Stored row only — no reconciliation, no chain RPC.
    const row = await deps.getRecord(token);
    if (!row) return { status: 404, body: { error: "Unknown payment." } };
    return { status: 200, body: { record: publicPayRecord(row) } };
  }

  if (toValues.length > 1) return fail(400, "Only one to address is allowed.", "invalid_request");
  const to = toValues[0];
  if (to && isAddress(to)) {
    if (!(await deps.rateLimit("pay.list_ip", deps.clientKey(request)))) return rateLimited();
    const requested = getAddress(to);
    const auth = await authorizeMerchantRead(request, requested, deps);
    if (!auth.ok) return auth.result;
    if (!(await deps.rateLimit("pay.list_merchant", `merchant:${auth.merchant}`))) return rateLimited();
    const rows = (await deps.listByPayee(auth.merchant)).filter((row) => ownsPayRecord(row, auth.merchant));
    // Phase 14: stored rows only. Zero reconciliation RPC on dashboard load.
    return { status: 200, body: { records: rows.map(publicPayRecord) } };
  }

  return { status: 400, body: { error: "token or to required" } };
}

async function registerInner(
  request: Request,
  token: string,
  identity: PayIdentity,
  deps: PayStatusDeps,
  bodyText = "",
): Promise<PayHttpResult> {
  let owner: Address;
  let storeToken = token;
  if (identity.version === 2) {
    const link = decodePayLink(token);
    if (!link || link.version !== 2) return fail(400, "Invalid payment link.", "invalid_request");
    const verify = deps.verifyV2Request ?? verifyFinalRequest;
    // Existing canonical EIP-712 check: the signature must recover to request.merchant.
    if (!(await verify(link.request))) {
      return fail(400, "Payment request signature is invalid.", "invalid_signature");
    }
    owner = getAddress(link.request.merchant);
    // Phase 14: persist the canonical encoding so variant tokens cannot fork identity.
    storeToken = encodeV2PayRequest(link.request);
    identity = payRecordIdentity(storeToken) ?? identity;
  } else {
    // V1 is unsigned. Only the authenticated payee may register it.
    const auth = await deps.authorize(request, {
      scope: "payment_requests:write",
      walletAction: WALLET_ACTIONS.paymentsRegister,
      bodyText,
    });
    if (!("merchant" in auth)) return fromApiError(auth);
    if (getAddress(auth.merchant) !== getAddress(identity.to)) {
      return fail(403, "Merchant does not match this payment link.", "forbidden");
    }
    owner = getAddress(auth.merchant);
  }

  const existing = await deps.getRecord(storeToken);
  if (existing) {
    // Idempotent. No write, no webhook, no settlement scan, no field overwrite.
    return { status: 200, body: { record: publicPayRecord(existing) } };
  }

  let createdRow: PayRecord;
  let created: boolean;
  try {
    const result = await deps.createOwnedRecord(blankRecord(storeToken, identity), owner);
    createdRow = result.record;
    created = result.created;
  } catch (err) {
    if (err instanceof ResourceLimitExceededError) {
      return fail(409, err.message, LIMIT_EXCEEDED_CODE);
    }
    if (err instanceof DuplicateRequestError) {
      return fail(409, err.message, err.code);
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

async function submitInner(
  request: Request,
  token: string,
  identity: PayIdentity,
  txHash: Hash,
  deps: PayStatusDeps,
): Promise<PayHttpResult> {
  const limitKey = `${deps.clientKey(request)}:${tokenFingerprint(token)}`;
  if (!(await deps.rateLimit("pay.submit", limitKey))) return rateLimited();

  // Resolve canonical V2 token when possible so submit hits the stored row.
  let storeToken = token;
  if (identity.version === 2) {
    const link = decodePayLink(token);
    if (link?.version === 2) {
      try {
        storeToken = encodeV2PayRequest(link.request);
      } catch {
        storeToken = token;
      }
    }
  }

  const row = (await deps.getRecord(storeToken)) ?? (await deps.getRecord(token));
  if (!row) return { status: 404, body: { error: "Unknown payment." } };

  const lookup = lookupFromRecord({
    token: row.token,
    to: row.to,
    amount: row.amount,
    memo: row.memo,
    cancelled: false,
  });
  if (!lookup) return fail(400, "Invalid payment link.", "invalid_request");

  const submit = deps.submitHash ?? submitTransactionHash;
  const outcome = await submit({
    token: row.token,
    txHash,
    row,
    lookup,
  });

  if (outcome.kind === "paid") {
    return { status: 200, body: { record: publicPayRecord(outcome.record) } };
  }
  if (outcome.kind === "rejected") {
    return fail(outcome.status, outcome.error, outcome.code);
  }
  if (outcome.kind === "unavailable") return unavailable();
  // Candidate stored (or already present). Not PAID yet.
  return { status: 200, body: { record: publicPayRecord(outcome.record) } };
}

async function reconcileInner(
  request: Request,
  token: string,
  identity: PayIdentity,
  optionalTxHash: Hash | null,
  deps: PayStatusDeps,
  bodyText = "",
): Promise<PayHttpResult> {
  const auth = await deps.authorize(request, {
    scope: "payment_requests:write",
    walletAction: WALLET_ACTIONS.paymentsRegister,
    bodyText,
  });
  if (!("merchant" in auth)) return fromApiError(auth);
  const merchant = getAddress(auth.merchant);
  if (!(await deps.rateLimit("pay.reconcile", `merchant:${merchant}`))) return rateLimited();

  let storeToken = token;
  if (identity.version === 2) {
    const link = decodePayLink(token);
    if (link?.version === 2) {
      try {
        storeToken = encodeV2PayRequest(link.request);
      } catch {
        storeToken = token;
      }
    }
  }

  const row = (await deps.getRecord(storeToken)) ?? (await deps.getRecord(token));
  if (!row || !ownsPayRecord(row, merchant)) return notFound();

  const reconcile = deps.reconcileOne ?? reconcileOnePayment;
  const outcome = await reconcile({
    row,
    optionalTxHash: optionalTxHash ?? undefined,
    allowScan: true,
    findProof: deps.findSettlementProof,
  });

  if (outcome.kind === "unavailable") return unavailable();
  if (outcome.kind === "rejected") return fail(outcome.status, outcome.error, outcome.code);
  if (outcome.kind === "paid") return { status: 200, body: { record: publicPayRecord(outcome.record) } };
  return { status: 200, body: { record: publicPayRecord(outcome.record) } };
}

async function payPostInner(request: Request, body: PostBody, deps: PayStatusDeps, bodyText = ""): Promise<PayHttpResult> {
  const token = tokenFrom(body);
  if (!token) return { status: 400, body: { error: "token required" } };
  const identity = payRecordIdentity(token);
  if (!identity) return { status: 400, body: { error: "Invalid payment link." } };

  const action = body.action ?? "register";

  if (action === "register") return registerInner(request, token, identity, deps, bodyText);

  if (action === "view") {
    // Public. Counts a view on an EXISTING row only. Never creates a row,
    // never scans the chain, never sends a notification.
    const row = await deps.getRecord(token);
    if (!row) return { status: 404, body: { error: "Unknown payment." } };
    const next = (await deps.markViewed(token)) ?? row;
    return { status: 200, body: { record: publicPayRecord(next) } };
  }

  if (action === "submit") {
    const txHash = parseTxHash(body.txHash);
    if (!txHash) return fail(400, "Valid transaction hash required.", "invalid_tx_hash");
    return submitInner(request, token, identity, txHash, deps);
  }

  if (action === "reconcile") {
    const txHash = body.txHash === undefined || body.txHash === null ? null : parseTxHash(body.txHash);
    if (body.txHash !== undefined && body.txHash !== null && !txHash) {
      return fail(400, "Valid transaction hash required.", "invalid_tx_hash");
    }
    return reconcileInner(request, token, identity, txHash, deps, bodyText);
  }

  if (action === "cancel") {
    // Resolve canonical token for V2 so cancel hits the stored row.
    let storeToken = token;
    let storeIdentity = identity;
    if (identity.version === 2) {
      const link = decodePayLink(token);
      if (link?.version === 2) {
        try {
          storeToken = encodeV2PayRequest(link.request);
          storeIdentity = payRecordIdentity(storeToken) ?? identity;
        } catch {
          storeToken = token;
        }
      }
    }
    const lookup = lookupFromRecord({
      token: storeToken,
      to: storeIdentity.to,
      amount: storeIdentity.amount,
      memo: storeIdentity.memo,
      cancelled: false,
    });
    const resolved = await resolveCancellation(
      {
        token: storeToken,
        identity: storeIdentity,
        lookup,
        address: typeof body.address === "string" ? body.address : undefined,
        signature: typeof body.signature === "string" ? body.signature : undefined,
        nowSeconds: Math.floor(Date.now() / 1000),
      },
      {
        getRecord: deps.getRecord,
        markCancelled: deps.markCancelled,
        ensureRecord: () => deps.upsertRecord(blankRecord(storeToken, storeIdentity)),
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
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return { status: 400, body: { error: "token required" } };
  }
  let body: PostBody;
  try {
    const parsed = bodyText.length === 0 ? null : (JSON.parse(bodyText) as unknown);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: 400, body: { error: "token required" } };
    }
    body = parsed as PostBody;
  } catch {
    return { status: 400, body: { error: "token required" } };
  }
  if (!(await deps.rateLimit("pay.write", deps.clientKey(request)))) return rateLimited();
  try {
    return await payPostInner(request, body, deps, bodyText);
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
  if (!(await deps.rateLimit("statement.ip", deps.clientKey(request)))) return rateLimited();
  let account: Address;
  try {
    const auth = await authorizeMerchantRead(request, requested, deps);
    if (!auth.ok) return auth.result;
    account = auth.merchant;
  } catch {
    return unavailable();
  }
  if (!(await deps.rateLimit("statement.merchant", `merchant:${account}`))) return rateLimited();
  try {
    const payments = await deps.loadMemoLedger(account);
    const links = (await deps.listByPayee(account)).filter((row) => ownsPayRecord(row, account));
    // Phase 14: statement must not mutate payment records via reconciliation.
    return { status: 200, body: { payments, links: links.map(publicPayRecord) } };
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
  rateLimit: (routeClass, key) => legacyAllow(routeClass, key),
  clientKey: (request) => requestClientKey(request),
};
