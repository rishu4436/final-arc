import { getAddress, isAddress, isHex, parseUnits, type Address, type Hex } from "viem";
import { ARC_CHAIN_ID, USDC_DECIMALS } from "./arc";
import {
  assertFinalRequestActive,
  deriveMemoId,
  recoverFinalRequestSigner,
  validateFinalRequest,
  verifyFinalRequest,
  FINAL_REQUEST_VERSION,
  type FinalRequest,
  type UnsignedFinalRequest,
} from "./finalRequest";

export type PayRequest = {
  v: 1;
  to: Address;
  amount: string;
  memo: string;
  id: string;
};

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(token: string): Uint8Array {
  const padded = token.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const bin = atob(padded + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function newId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function encodePayRequest(input: {
  to: string;
  amount: string;
  memo: string;
}): string {
  const req = parsePayFields(input);
  const json = JSON.stringify({
    v: 1,
    to: req.to,
    amount: req.amount,
    memo: req.memo,
    id: newId(),
  });
  return toBase64Url(new TextEncoder().encode(json));
}

export function decodePayRequest(token: string): PayRequest | null {
  try {
    const json = new TextDecoder().decode(fromBase64Url(token));
    const raw = JSON.parse(json) as Partial<PayRequest>;
    if (raw.v !== 1) return null;
    const fields = parsePayFields({
      to: String(raw.to ?? ""),
      amount: String(raw.amount ?? ""),
      memo: String(raw.memo ?? ""),
    });
    return { ...fields, id: typeof raw.id === "string" && raw.id ? raw.id : "legacy" };
  } catch {
    return null;
  }
}

export function parsePayFields(input: {
  to: string;
  amount: string;
  memo: string;
}): PayRequest {
  if (!isAddress(input.to)) {
    throw new Error("Recipient must be a valid 0x address.");
  }
  const memo = input.memo.trim();
  if (!memo) throw new Error("A memo is required.");
  if (memo.length > 200) throw new Error("Memo must be 200 characters or fewer.");
  const amount = input.amount.trim();
  const amount6 = parseUnits(amount, USDC_DECIMALS);
  if (amount6 <= 0n) throw new Error("Amount must be greater than zero.");
  return { v: 1, to: getAddress(input.to), amount, memo, id: "legacy" };
}


export type DecodedPayLink =
  | { version: 1; request: PayRequest }
  | { version: 2; request: FinalRequest };

/**
 * UI phase. EXPIRED is derived from the clock, not stored.
 * PAID wins over the clock: a settlement that landed before expiry can be
 * indexed later and must still show as paid. This does not change that rule.
 */
export type PayLinkPhase = "OPEN" | "PAID" | "CANCELLED" | "EXPIRED";

export function paymentLinkPhase(input: {
  paid: boolean;
  cancelled: boolean;
  /** Null for V1, which has no expiry. */
  expiresAt: number | null;
  nowSeconds: number;
}): PayLinkPhase {
  if (input.paid) return "PAID";
  if (input.cancelled) return "CANCELLED";
  if (input.expiresAt != null && input.nowSeconds >= input.expiresAt) return "EXPIRED";
  return "OPEN";
}

/** Active Pay is only offered while the request is still open. */
export function canOfferPay(phase: PayLinkPhase): boolean {
  return phase === "OPEN";
}

/**
 * V1 cancel stays a legacy payee-address check.
 * V2 cancel is offered only to the merchant, and only while the request is open.
 */
export function cancelOffer(input: {
  token: string;
  address: string;
  paid: boolean;
  cancelled: boolean;
  nowSeconds: number;
}): "legacy" | "v2" | null {
  const link = decodePayLink(input.token);
  if (!link || !isAddress(input.address)) return null;
  const expiresAt = link.version === 2 ? link.request.expiresAt : null;
  const phase = paymentLinkPhase({
    paid: input.paid,
    cancelled: input.cancelled,
    expiresAt,
    nowSeconds: input.nowSeconds,
  });
  if (phase !== "OPEN") return null;
  const viewer = getAddress(input.address);
  if (link.version === 1) {
    return link.request.to === viewer ? "legacy" : null;
  }
  return link.request.merchant === viewer ? "v2" : null;
}

/** Client gate. Does not decide whether a past in-time settlement can be indexed. */
export function assertV2Payable(input: {
  expiresAt: number;
  nowSeconds: number;
  cancelled?: boolean;
  paid?: boolean;
}): void {
  if (input.paid) throw new Error("Payment request is already paid.");
  if (input.cancelled) throw new Error("Payment request has been cancelled.");
  assertFinalRequestActive({ expiresAt: input.expiresAt }, input.nowSeconds);
}

function parseTokenJson(token: string): Record<string, unknown> | null {
  try {
    const json = new TextDecoder().decode(fromBase64Url(token));
    const raw = JSON.parse(json) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    return raw as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** True when the payload claims V2, even if the claim is malformed. */
export function claimsV2PayToken(token: string): boolean {
  const raw = parseTokenJson(token);
  if (!raw) return false;
  if (raw.v === 1) return false;
  return raw.v === 2 || raw.version === 2;
}

function finalRequestFromPayload(raw: Record<string, unknown>): FinalRequest | null {
  const recipient = raw.recipient ?? raw.to;
  const amount = raw.amountBaseUnits;
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) return null;
  if (typeof raw.requestId !== "string") return null;
  if (typeof raw.merchant !== "string") return null;
  if (typeof recipient !== "string") return null;
  if (typeof raw.memo !== "string") return null;
  if (raw.chainId !== ARC_CHAIN_ID) return null;
  if (typeof raw.expiresAt !== "number" || !Number.isSafeInteger(raw.expiresAt)) return null;
  if (typeof raw.nonce !== "string") return null;
  if (typeof raw.signature !== "string" || !isHex(raw.signature, { strict: true })) return null;
  try {
    const fields = validateFinalRequest({
      version: FINAL_REQUEST_VERSION,
      requestId: raw.requestId,
      merchant: raw.merchant,
      recipient,
      amountBaseUnits: BigInt(amount),
      memo: raw.memo,
      chainId: ARC_CHAIN_ID,
      expiresAt: raw.expiresAt,
      nonce: raw.nonce,
    });
    return { ...fields, signature: raw.signature };
  } catch {
    return null;
  }
}

/**
 * Encode a signed V2 request. amountBaseUnits is the decimal integer string,
 * never the human USDC decimal. A V1 token is never rewritten into this shape.
 */
export function encodeV2PayRequest(request: FinalRequest): string {
  const fields = validateFinalRequest(request);
  if (!isHex(request.signature, { strict: true })) {
    throw new Error("Payment request signature is invalid.");
  }
  const json = JSON.stringify({
    v: 2,
    requestId: fields.requestId,
    merchant: fields.merchant,
    recipient: fields.recipient,
    amountBaseUnits: fields.amountBaseUnits.toString(),
    memo: fields.memo,
    chainId: fields.chainId,
    expiresAt: fields.expiresAt,
    nonce: fields.nonce,
    signature: request.signature,
  });
  return toBase64Url(new TextEncoder().encode(json));
}

/**
 * V1 tokens stay V1. A V2 claim that does not verify structurally is null,
 * not a V1 payment. decodePayRequest is unchanged and still requires v === 1.
 */
export function decodePayLink(token: string): DecodedPayLink | null {
  const v1 = decodePayRequest(token);
  if (v1) return { version: 1, request: v1 };
  if (!claimsV2PayToken(token)) return null;
  const raw = parseTokenJson(token);
  if (!raw) return null;
  const request = finalRequestFromPayload(raw);
  if (!request) return null;
  return { version: 2, request };
}

/**
 * Check the signature the wallet actually returned. On failure this throws
 * and does not return a token. Fields are not rewritten to match the signer.
 */
export async function sealSignedV2Request(input: {
  request: UnsignedFinalRequest;
  signature: Hex;
  connectedMerchant: string;
  nowSeconds?: number;
}): Promise<{ request: FinalRequest; memoId: Hex; token: string }> {
  const fields = validateFinalRequest(input.request);
  if (!isAddress(input.connectedMerchant)) {
    throw new Error("Connect the merchant wallet.");
  }
  if (getAddress(input.connectedMerchant) !== fields.merchant) {
    throw new Error("Connected wallet is not the merchant on this request.");
  }
  if (!isHex(input.signature, { strict: true })) {
    throw new Error("Payment request signature is invalid.");
  }
  const signed: FinalRequest = { ...fields, signature: input.signature };
  let signer: Address;
  try {
    signer = await recoverFinalRequestSigner(signed);
  } catch {
    throw new Error("Wallet signature does not match the connected merchant.");
  }
  if (signer !== fields.merchant) {
    throw new Error("Wallet signature does not match the connected merchant.");
  }
  const verified = await verifyFinalRequest(signed);
  if (!verified) {
    throw new Error("Payment request signature is invalid.");
  }
  assertFinalRequestActive(signed, input.nowSeconds);
  const memoId = deriveMemoId(signed.requestId);
  return { request: signed, memoId, token: encodeV2PayRequest(signed) };
}
