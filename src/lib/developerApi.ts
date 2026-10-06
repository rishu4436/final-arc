import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { authenticateAuthorization, liveApiKeyRuntime, type ApiKeyRuntime } from "./apiKeys";
import type { ApiScope } from "./apiScopes";
import { ARC_CHAIN_ID } from "./arc";
import {
  FINAL_REQUEST_PRIMARY_TYPE,
  FINAL_REQUEST_TYPES,
  FINAL_REQUEST_VERSION,
  assertFinalRequestActive,
  deriveMemoId,
  finalRequestTypedData,
  validateFinalRequest,
  type FinalRequest,
  type FinalRequestDraft,
} from "./finalRequest";
import {
  assembleArcProof,
  isArcProofBody,
  verifyArcTransaction,
  type ArcProofBody,
  type ArcProofDeps,
} from "./arcProof";
import { loadReceipt, type LoadedReceipt } from "./loadReceipt";
import { payRecordIdentity } from "./payPaid";
import { decodePayLink, paymentLinkPhase, sealSignedV2Request, type PayLinkPhase } from "./payRequest";
import { isTxHash } from "./receipt";
import { DuplicateRequestError, createPayRecord, listRecords, upsertRecord, type PayRecord } from "./payStore";
import { LIMIT_EXCEEDED_CODE, ResourceLimitExceededError } from "./resourceLimits";
import { emitPaymentRequestCreated } from "./webhooks";

/**
 * Same origin the root layout uses for metadataBase.
 * Absolute payment and receipt URLs are this origin plus the existing /p and /r paths.
 */
export const DEFAULT_SITE_ORIGIN = "https://final-arc-eight.vercel.app";

export function siteOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.NEXT_PUBLIC_SITE_URL?.trim();
  const raw = configured && configured.length > 0 ? configured : DEFAULT_SITE_ORIGIN;
  return raw.replace(/\/+$/, "");
}

export const API_ERROR_CODES = {
  invalidJson: "invalid_json",
  invalidAddress: "invalid_address",
  invalidAmount: "invalid_amount",
  invalidChain: "invalid_chain",
  invalidExpiry: "invalid_expiry",
  invalidMemo: "invalid_memo",
  invalidRequestId: "invalid_request_id",
  invalidNonce: "invalid_nonce",
  invalidSignature: "invalid_signature",
  wrongSigner: "wrong_signer",
  recipientMismatch: "recipient_mismatch",
  invalidRequest: "invalid_request",
  expired: "expired",
  notFound: "not_found",
  notSettled: "not_settled",
  receiptUnavailable: "receipt_unavailable",
  invalidTransaction: "invalid_transaction",
  transactionNotFound: "transaction_not_found",
  storeUnavailable: "store_unavailable",
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  rateLimited: "rate_limited",
  unavailable: "unavailable",
  internal: "internal",
} as const;

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
  };
};

export type ApiResult = {
  status: number;
  body: ApiErrorBody | PaymentRequestResource | UnsignedPaymentRequest | ReceiptApiBody | VerifyApiBody;
};

export type PaymentRequestResource = {
  requestId: string;
  merchant: string;
  recipient: string;
  amountBaseUnits: string;
  memo: string;
  expiresAt: number;
  nonce: string;
  memoId: string;
  status: PayLinkPhase;
  paymentUrl: string;
  transactionHash: string | null;
  receiptUrl: string | null;
};

export type UnsignedPaymentRequest = {
  accepted: false;
  status: "UNSIGNED";
  paymentUrl: null;
  typedData: {
    domain: { name: string; version: string; chainId: number };
    primaryType: typeof FINAL_REQUEST_PRIMARY_TYPE;
    types: typeof FINAL_REQUEST_TYPES;
    message: {
      requestId: string;
      recipient: string;
      amountBaseUnits: string;
      memo: string;
      chainId: number;
      expiresAt: number;
      nonce: string;
    };
  };
};

export type ReceiptApiBody = {
  available: true;
  /** The receipt loader does not check this request. Always false. */
  boundToRequest: false;
  requestId: string;
  transactionHash: string;
  chain: "Arc";
  chainId: typeof ARC_CHAIN_ID;
  blockNumber: string;
  blockHash: string | null;
  memo: string | null;
  memoId: string | null;
  usdcTransfer: {
    amount: string;
    sender: string | null;
    recipient: string | null;
  };
  transactionSucceeded: boolean;
  memoEventValid: boolean;
  settlementValid: boolean;
  certificate: {
    matched: boolean;
    height: number | null;
    blockHash: string | null;
    signatureCount: number;
    signaturesCryptographicallyVerified: false;
    note: string;
  };
  /** Canonical read-only proof. boundToRequest on this object stays false. */
  status: ArcProofBody["status"];
  proof: ArcProofBody;
  note: string;
};

export type VerifyApiBody = {
  transactionHash: string;
  chain: "Arc";
  chainId: typeof ARC_CHAIN_ID;
  blockNumber: string;
  blockHash: string | null;
  memo: string | null;
  memoId: string | null;
  usdcTransfer: {
    amount: string;
    sender: string | null;
    recipient: string | null;
  };
  transactionSucceeded: boolean;
  memoEventValid: boolean;
  settlementValid: boolean;
  certificate: ReceiptApiBody["certificate"];
  /** Canonical read-only proof. This is not a paid state and not a merchant binding. */
  status: ArcProofBody["status"];
  proof: ArcProofBody;
  note: string;
};

export type DeveloperApiDeps = {
  nowSeconds: () => number;
  origin: string;
  upsertRecord: (record: PayRecord) => Promise<PayRecord>;
  /** Atomic create-or-merge with per-merchant create cap on the CAS snapshot. */
  createOwnedRecord: (record: PayRecord, owner: Address) => Promise<{ record: PayRecord; created: boolean }>;
  listRecords: () => Promise<PayRecord[]>;
  loadReceipt: (hash: string) => Promise<LoadedReceipt | { error: string; status: number }>;
  /** Bearer header for GET handlers. POST reads the Request header first. */
  authorization: string | null;
  apiKeyAuth: ApiKeyRuntime;
};

const RECEIPT_NOTE =
  "These facts come from the existing Arc receipt loader. They describe that transaction. They do not prove it settles a payment request. Validator signatures are not cryptographically verified.";

const LOADER_CHAIN_NOTE =
  "chain and chainId name the network the existing receipt loader queries (Arc mainnet). They are not a chain id read from the transaction.";

export class DeveloperApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status: number, code: string, message: string): never {
  throw new DeveloperApiError(status, code, message);
}

export function apiError(status: number, code: string, message: string): ApiResult {
  return { status, body: { error: { code, message } } };
}

function asError(err: unknown): ApiResult {
  if (err instanceof DeveloperApiError) {
    return apiError(err.status, err.code, err.message);
  }
  return apiError(500, API_ERROR_CODES.internal, "Something went wrong.");
}

export function paymentUrl(origin: string, token: string): string {
  return `${origin}/p/${token}`;
}

export function receiptUrl(origin: string, hash: string): string {
  return `${origin}/r/${hash}`;
}

function blankRecord(token: string, identity: { id: string; to: PayRecord["to"]; amount: string; memo: string }): PayRecord {
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
    webhookUrl: null,
  };
}

/**
 * Earliest stored V2 row whose decoded requestId matches.
 * Scans the existing blob. Does not create a requestId index.
 */
export function findStoredRequest(
  records: PayRecord[],
  requestId: string,
  merchant?: Address,
): { row: PayRecord; request: FinalRequest } | null {
  if (!/^0x[0-9a-fA-F]{32}$/.test(requestId)) return null;
  const needle = requestId.toLowerCase();
  const owner = merchant?.toLowerCase();
  const matches: { row: PayRecord; request: FinalRequest; created: number }[] = [];
  for (const row of records) {
    if (!row || typeof row.token !== "string") continue;
    const link = decodePayLink(row.token);
    if (!link || link.version !== 2) continue;
    if (link.request.requestId.toLowerCase() !== needle) continue;
    if (owner && link.request.merchant.toLowerCase() !== owner) continue;
    const created = Date.parse(row.createdAt);
    matches.push({
      row,
      request: link.request,
      created: Number.isNaN(created) ? 0 : created,
    });
  }
  matches.sort((a, b) => a.created - b.created || (a.row.token < b.row.token ? -1 : a.row.token > b.row.token ? 1 : 0));
  const found = matches[0];
  return found ? { row: found.row, request: found.request } : null;
}

export function toPaymentResource(
  row: PayRecord,
  request: FinalRequest,
  origin: string,
  nowSeconds: number,
): PaymentRequestResource {
  const hash = typeof row.paidTx === "string" && isTxHash(row.paidTx) ? row.paidTx : null;
  return {
    requestId: request.requestId,
    merchant: request.merchant,
    recipient: request.recipient,
    amountBaseUnits: request.amountBaseUnits.toString(),
    memo: request.memo,
    expiresAt: request.expiresAt,
    nonce: request.nonce,
    memoId: deriveMemoId(request.requestId),
    status: paymentLinkPhase({
      paid: Boolean(row.paidTx),
      cancelled: row.cancelled === true,
      expiresAt: request.expiresAt,
      nowSeconds,
    }),
    paymentUrl: paymentUrl(origin, row.token),
    transactionHash: hash,
    receiptUrl: hash ? receiptUrl(origin, hash) : null,
  };
}

function parseAmountBaseUnits(value: unknown): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail(
        400,
        API_ERROR_CODES.invalidAmount,
        "amountBaseUnits must be a positive integer string. A JSON number is accepted only when it is a safe integer.",
      );
    }
    return BigInt(value);
  }
  if (typeof value !== "string") {
    fail(
      400,
      API_ERROR_CODES.invalidAmount,
      "amountBaseUnits must be a positive integer string of USDC base units (6 decimals).",
    );
  }
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    fail(
      400,
      API_ERROR_CODES.invalidAmount,
      "amountBaseUnits must be a canonical positive integer string of USDC base units (6 decimals), not a decimal amount.",
    );
  }
  return BigInt(trimmed);
}

function parseChainId(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  fail(400, API_ERROR_CODES.invalidChain, "chainId must be 5042.");
}

function parseExpiresAt(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  fail(400, API_ERROR_CODES.invalidExpiry, "expiresAt must be a unix timestamp in seconds.");
}

function parseDraft(body: Record<string, unknown>): FinalRequestDraft {
  if (typeof body.requestId !== "string") {
    fail(400, API_ERROR_CODES.invalidRequestId, "requestId must be 16 bytes.");
  }
  if (typeof body.merchant !== "string") {
    fail(400, API_ERROR_CODES.invalidAddress, "Merchant must be a valid 0x address.");
  }
  if (typeof body.recipient !== "string") {
    fail(400, API_ERROR_CODES.invalidAddress, "Recipient must be a valid 0x address.");
  }
  if (typeof body.memo !== "string") {
    fail(400, API_ERROR_CODES.invalidMemo, "A memo is required.");
  }
  if (typeof body.nonce !== "string") {
    fail(400, API_ERROR_CODES.invalidNonce, "nonce must be 32 bytes.");
  }
  return {
    version: FINAL_REQUEST_VERSION,
    requestId: body.requestId,
    merchant: body.merchant,
    recipient: body.recipient,
    amountBaseUnits: parseAmountBaseUnits(body.amountBaseUnits),
    memo: body.memo,
    chainId: parseChainId(body.chainId),
    expiresAt: parseExpiresAt(body.expiresAt),
    nonce: body.nonce,
  };
}

function mapValidation(err: unknown): never {
  if (err instanceof DeveloperApiError) throw err;
  const message = err instanceof Error ? err.message : "Invalid payment request.";
  if (message === "Merchant must be a valid 0x address." || message === "Recipient must be a valid 0x address.") {
    fail(400, API_ERROR_CODES.invalidAddress, message);
  }
  if (message === "Recipient must be the merchant wallet.") {
    fail(400, API_ERROR_CODES.recipientMismatch, message);
  }
  if (message === "V2 requests are Arc-only (chainId 5042).") {
    fail(400, API_ERROR_CODES.invalidChain, message);
  }
  if (message === "Payment request has expired.") {
    fail(400, API_ERROR_CODES.expired, message);
  }
  if (message === "expiresAt must be a unix timestamp in seconds.") {
    fail(400, API_ERROR_CODES.invalidExpiry, message);
  }
  if (
    message === "Amount must be greater than zero." ||
    message === "amountBaseUnits must be a bigint." ||
    message === "Amount must not be negative." ||
    message === "Amount is not a valid USDC value." ||
    message === "Amount has more than 6 decimal places."
  ) {
    fail(400, API_ERROR_CODES.invalidAmount, message);
  }
  if (
    message === "A memo is required." ||
    message === "Memo must be 200 characters or fewer." ||
    message === "Memo must not have leading or trailing whitespace."
  ) {
    fail(400, API_ERROR_CODES.invalidMemo, message);
  }
  if (message.startsWith("requestId must be")) {
    fail(400, API_ERROR_CODES.invalidRequestId, message);
  }
  if (message.startsWith("nonce must be")) {
    fail(400, API_ERROR_CODES.invalidNonce, message);
  }
  if (
    message === "Payment request signature is invalid." ||
    message === "Signature must be a hex string."
  ) {
    fail(400, API_ERROR_CODES.invalidSignature, message);
  }
  if (
    message === "Wallet signature does not match the connected merchant." ||
    message === "Merchant must match the signing account." ||
    message === "Connected wallet is not the merchant on this request."
  ) {
    fail(400, API_ERROR_CODES.wrongSigner, message);
  }
  fail(400, API_ERROR_CODES.invalidRequest, message);
}

function unsignedResponse(draft: FinalRequestDraft, nowSeconds: number): UnsignedPaymentRequest {
  let fields;
  try {
    fields = validateFinalRequest(draft);
    assertFinalRequestActive(fields, nowSeconds);
  } catch (err) {
    mapValidation(err);
  }
  const typed = finalRequestTypedData(fields);
  return {
    accepted: false,
    status: "UNSIGNED",
    paymentUrl: null,
    typedData: {
      domain: {
        name: typed.domain.name,
        version: typed.domain.version,
        chainId: typed.domain.chainId,
      },
      primaryType: typed.primaryType,
      types: typed.types,
      message: {
        requestId: typed.message.requestId,
        recipient: typed.message.recipient,
        amountBaseUnits: typed.message.amountBaseUnits.toString(),
        memo: typed.message.memo,
        chainId: Number(typed.message.chainId),
        expiresAt: Number(typed.message.expiresAt),
        nonce: typed.message.nonce,
      },
    },
  };
}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    fail(400, API_ERROR_CODES.invalidJson, "Request body must be JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(400, API_ERROR_CODES.invalidJson, "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

async function requireAccess(
  scope: ApiScope,
  authorization: string | null,
  deps: DeveloperApiDeps,
): Promise<Address> {
  const auth = await authenticateAuthorization(authorization, scope, deps.apiKeyAuth);
  if (!auth.ok) fail(auth.status, auth.code, auth.message);
  return auth.merchant;
}

function readSignature(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    fail(400, API_ERROR_CODES.invalidSignature, "Payment request signature is invalid.");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function createPaymentRequest(
  request: Request,
  deps: DeveloperApiDeps,
  options?: { caller?: Address },
): Promise<ApiResult> {
  try {
    // options.caller is only for a route that already authenticated the merchant.
    // The public payment-request route does not pass it, so it still requires payment_requests:write.
    const caller =
      options?.caller ??
      (await requireAccess(
        "payment_requests:write",
        request.headers.get("authorization") ?? deps.authorization,
        deps,
      ));
    const body = await readObject(request);
    if (typeof body.merchant === "string" && isAddress(body.merchant) && getAddress(body.merchant) !== caller) {
      fail(403, API_ERROR_CODES.forbidden, "Merchant does not match the API key.");
    }
    const draft = parseDraft(body);
    const signature = readSignature(body.signature);
    if (!signature) {
      return { status: 200, body: unsignedResponse(draft, deps.nowSeconds()) };
    }
    if (!isHex(signature, { strict: true })) {
      fail(400, API_ERROR_CODES.invalidSignature, "Payment request signature is invalid.");
    }
    let sealed;
    try {
      const fields = validateFinalRequest(draft);
      sealed = await sealSignedV2Request({
        request: fields,
        signature: signature as Hex,
        connectedMerchant: fields.merchant,
        nowSeconds: deps.nowSeconds(),
      });
    } catch (err) {
      mapValidation(err);
    }
    const identity = payRecordIdentity(sealed.token);
    if (!identity || identity.version !== 2) {
      fail(500, API_ERROR_CODES.internal, "Could not store the payment request.");
    }
    let row: PayRecord;
    let created = false;
    try {
      const result = await deps.createOwnedRecord(blankRecord(sealed.token, identity), sealed.request.merchant);
      row = result.record;
      created = result.created;
    } catch (err) {
      if (err instanceof ResourceLimitExceededError) {
        fail(409, LIMIT_EXCEEDED_CODE, err.message);
      }
      if (err instanceof DuplicateRequestError) {
        fail(409, "duplicate_request", err.message);
      }
      fail(503, API_ERROR_CODES.storeUnavailable, "Payment store is unavailable.");
    }
    // First store of this token only. A later /api/pay register of the same token does not re-emit.
    if (created) emitPaymentRequestCreated(row);
    return {
      status: 200,
      body: toPaymentResource(row, sealed.request, deps.origin, deps.nowSeconds()),
    };
  } catch (err) {
    return asError(err);
  }
}

async function loadMatch(
  id: string,
  deps: DeveloperApiDeps,
  merchant: Address,
): Promise<{ row: PayRecord; request: FinalRequest }> {
  let records: PayRecord[];
  try {
    records = await deps.listRecords();
  } catch {
    fail(503, API_ERROR_CODES.storeUnavailable, "Payment store is unavailable.");
  }
  const found = findStoredRequest(records, id, merchant);
  if (!found) {
    fail(404, API_ERROR_CODES.notFound, "Unknown payment request.");
  }
  return found;
}

function knownRequestId(id: string): boolean {
  return /^0x[0-9a-fA-F]{32}$/.test(id);
}

export async function getPaymentRequest(id: string, deps: DeveloperApiDeps): Promise<ApiResult> {
  try {
    const caller = await requireAccess("payment_requests:read", deps.authorization, deps);
    if (!knownRequestId(id)) {
      fail(404, API_ERROR_CODES.notFound, "Unknown payment request.");
    }
    const found = await loadMatch(id, deps, caller);
    return {
      status: 200,
      body: toPaymentResource(found.row, found.request, deps.origin, deps.nowSeconds()),
    };
  } catch (err) {
    return asError(err);
  }
}

function proofDeps(deps: DeveloperApiDeps): ArcProofDeps {
  return {
    load: async (hash) => {
      let loaded: LoadedReceipt | { error: string; status: number };
      try {
        loaded = await deps.loadReceipt(hash);
      } catch {
        return { kind: "unavailable" };
      }
      if ("error" in loaded) {
        if (loaded.status >= 500) return { kind: "unavailable" };
        return { kind: "not_found" };
      }
      return { kind: "loaded", loaded };
    },
  };
}

function legacyFromProof(proof: ArcProofBody): VerifyApiBody {
  return {
    transactionHash: proof.transactionHash,
    chain: proof.chain,
    chainId: proof.chainId,
    blockNumber: proof.transaction.blockNumber,
    blockHash: proof.transaction.blockHash,
    memo: proof.memo.memo,
    memoId: proof.memo.memoId,
    usdcTransfer: {
      amount: proof.settlement.amount ?? "0",
      sender: proof.memo.sender,
      recipient: proof.settlement.to,
    },
    transactionSucceeded: proof.transaction.success,
    memoEventValid: proof.memo.valid,
    settlementValid: proof.settlement.valid,
    certificate: {
      matched: proof.certificate.matchesTransaction === true,
      height: proof.certificate.height,
      blockHash: proof.certificate.blockHash,
      signatureCount: proof.certificate.signatureCount ?? 0,
      signaturesCryptographicallyVerified: false,
      note: proof.certificate.note,
    },
    status: proof.status,
    proof,
    note: `${RECEIPT_NOTE} ${LOADER_CHAIN_NOTE}`,
  };
}

export function verifyFacts(loaded: LoadedReceipt): VerifyApiBody {
  return legacyFromProof(assembleArcProof(loaded.parsed, loaded.certificate, null));
}

function mapProofFailure(result: { status: string }): never {
  if (result.status === "INVALID_FORMAT") {
    fail(400, API_ERROR_CODES.invalidTransaction, "Invalid transaction hash.");
  }
  if (result.status === "UNAVAILABLE") {
    fail(503, API_ERROR_CODES.unavailable, "Arc transaction data is unavailable.");
  }
  fail(404, API_ERROR_CODES.transactionNotFound, "Transaction not found on Arc mainnet.");
}

export async function getPaymentReceipt(id: string, deps: DeveloperApiDeps): Promise<ApiResult> {
  try {
    const caller = await requireAccess("receipts:read", deps.authorization, deps);
    if (!knownRequestId(id)) {
      fail(404, API_ERROR_CODES.notFound, "Unknown payment request.");
    }
    const found = await loadMatch(id, deps, caller);
    const hash = typeof found.row.paidTx === "string" && isTxHash(found.row.paidTx) ? found.row.paidTx : null;
    if (!hash) {
      fail(
        404,
        API_ERROR_CODES.notSettled,
        "This request has no settled transaction. A verified receipt is not available.",
      );
    }
    const result = await verifyArcTransaction(hash, proofDeps(deps));
    if (!isArcProofBody(result)) {
      if (result.status === "UNAVAILABLE") {
        fail(503, API_ERROR_CODES.unavailable, "Arc transaction data is unavailable.");
      }
      if (result.status === "INVALID_FORMAT") {
        fail(400, API_ERROR_CODES.invalidTransaction, "Invalid transaction hash.");
      }
      fail(
        404,
        API_ERROR_CODES.receiptUnavailable,
        "A verified receipt is not available for the stored transaction.",
      );
    }
    const facts = legacyFromProof(result);
    return {
      status: 200,
      body: {
        available: true,
        boundToRequest: false,
        requestId: found.request.requestId,
        ...facts,
      },
    };
  } catch (err) {
    return asError(err);
  }
}

export async function verifyTransaction(tx: string, deps: DeveloperApiDeps): Promise<ApiResult> {
  try {
    // verification:read authorizes the call. The transaction is not filtered by merchant.
    // A verified transaction is not proof that it belongs to the caller or that a request is paid.
    await requireAccess("verification:read", deps.authorization, deps);
    const result = await verifyArcTransaction(tx, proofDeps(deps));
    if (!isArcProofBody(result)) mapProofFailure(result);
    return { status: 200, body: legacyFromProof(result) };
  } catch (err) {
    return asError(err);
  }
}

export function liveDeveloperApiDeps(authorization: string | null = null): DeveloperApiDeps {
  return {
    nowSeconds: () => Math.floor(Date.now() / 1000),
    origin: siteOrigin(),
    upsertRecord,
    createOwnedRecord: createPayRecord,
    listRecords,
    loadReceipt,
    authorization,
    apiKeyAuth: liveApiKeyRuntime(),
  };
}
