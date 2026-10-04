import {
  bytesToHex,
  encodeAbiParameters,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  parseUnits,
  recoverTypedDataAddress,
  size,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ARC_CHAIN_ID, USDC_DECIMALS } from "./arc";

export const FINAL_REQUEST_VERSION = 2 as const;

/** Same limit as V1 payment requests. Never truncated. */
export const FINAL_MEMO_MAX_LENGTH = 200;

/**
 * Domain string mixed into memoId so a FINAL V2 request id cannot collide
 * with an arbitrary keccak256 (including the V1 hash of the human memo).
 */
export const FINAL_V2_MEMO_ID_DOMAIN = "FINAL V2 request identity" as const;

export const FINAL_EIP712_DOMAIN = {
  name: "FINAL",
  version: "2",
  chainId: ARC_CHAIN_ID,
} as const;

export const FINAL_REQUEST_PRIMARY_TYPE = "PaymentRequest" as const;

/**
 * Merchant is intentionally absent. The recovered EIP-712 signer is the merchant.
 * No verifyingContract: FINAL has no protocol contract yet.
 */
export const FINAL_REQUEST_TYPES = {
  PaymentRequest: [
    { name: "requestId", type: "bytes16" },
    { name: "recipient", type: "address" },
    { name: "amountBaseUnits", type: "uint256" },
    { name: "memo", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type FinalEip712Domain = {
  name: string;
  version: string;
  chainId: number;
};

export type UnsignedFinalRequest = {
  version: typeof FINAL_REQUEST_VERSION;
  requestId: Hex;
  merchant: Address;
  recipient: Address;
  amountBaseUnits: bigint;
  memo: string;
  chainId: typeof ARC_CHAIN_ID;
  expiresAt: number;
  nonce: Hex;
};

export type FinalRequest = UnsignedFinalRequest & {
  signature: Hex;
};

export type FinalRequestMessage = {
  requestId: Hex;
  recipient: Address;
  amountBaseUnits: bigint;
  memo: string;
  chainId: bigint;
  expiresAt: bigint;
  nonce: Hex;
};

export type CreateFinalRequestInput = {
  merchant: string;
  recipient: string;
  /** Decimal USDC string. Parsed to 6-decimal base units. Not a JS number. */
  amount: string;
  memo: string;
  /** Unix timestamp in seconds. Active while now < expiresAt. */
  expiresAt: number;
  requestId?: string;
  nonce?: string;
  chainId?: number;
};

/** Fields accepted by structural validation. Wider than the canonical type. */
export type FinalRequestDraft = {
  version: number;
  requestId: string;
  merchant: string;
  recipient: string;
  amountBaseUnits: bigint;
  memo: string;
  chainId: number;
  expiresAt: number;
  nonce: string;
};

const REQUEST_ID_BYTES = 16;
const NONCE_BYTES = 32;

function randomHex(byteLength: number): Hex {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function generateRequestId(): Hex {
  return randomHex(REQUEST_ID_BYTES);
}

export function generateNonce(): Hex {
  return randomHex(NONCE_BYTES);
}

function parseFixedHex(value: string, byteLength: number, label: string): Hex {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || size(value) !== byteLength) {
    throw new Error(`${label} must be ${byteLength} bytes.`);
  }
  return value.toLowerCase() as Hex;
}

/**
 * Canonical USDC base units (6 decimals). Rejects zero, negatives, more than
 * 6 fractional digits, and any non-decimal string. Does not use Number.
 */
export function parseUsdcBaseUnits(amount: string): bigint {
  if (typeof amount !== "string") {
    throw new Error("Amount is not a valid USDC value.");
  }
  const trimmed = amount.trim();
  if (trimmed.startsWith("-")) {
    throw new Error("Amount must not be negative.");
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    throw new Error("Amount is not a valid USDC value.");
  }
  const fraction = trimmed.split(".")[1] ?? "";
  if (fraction.length > USDC_DECIMALS) {
    throw new Error("Amount has more than 6 decimal places.");
  }
  let value: bigint;
  try {
    value = parseUnits(trimmed, USDC_DECIMALS);
  } catch {
    throw new Error("Amount is not a valid USDC value.");
  }
  if (value <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }
  return value;
}

/**
 * memoId = keccak256(abi.encode("FINAL V2 request identity", requestId))
 * requestId is bytes16. The human-readable memo is not an input.
 */
export function deriveMemoId(requestId: string): Hex {
  const id = parseFixedHex(requestId, REQUEST_ID_BYTES, "requestId");
  return keccak256(
    encodeAbiParameters(
      [
        { name: "domain", type: "string" },
        { name: "requestId", type: "bytes16" },
      ],
      [FINAL_V2_MEMO_ID_DOMAIN, id],
    ),
  );
}

function parseAddress(value: string, label: "Merchant" | "Recipient"): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new Error(`${label} must be a valid 0x address.`);
  }
  return getAddress(value);
}

/**
 * Structural checks only. Expiry is separate so a signed request can still
 * be decoded after it lapses.
 */
export function validateFinalRequest(draft: FinalRequestDraft): UnsignedFinalRequest {
  if (draft.version !== FINAL_REQUEST_VERSION) {
    throw new Error("Unsupported payment request version.");
  }
  if (draft.chainId !== ARC_CHAIN_ID) {
    throw new Error("V2 requests are Arc-only (chainId 5042).");
  }
  if (typeof draft.memo !== "string") {
    throw new Error("A memo is required.");
  }
  const memo = draft.memo.trim();
  if (!memo) throw new Error("A memo is required.");
  if (memo.length > FINAL_MEMO_MAX_LENGTH) {
    throw new Error("Memo must be 200 characters or fewer.");
  }
  if (memo !== draft.memo) {
    throw new Error("Memo must not have leading or trailing whitespace.");
  }
  if (typeof draft.amountBaseUnits !== "bigint") {
    throw new Error("amountBaseUnits must be a bigint.");
  }
  if (draft.amountBaseUnits <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }
  if (!Number.isSafeInteger(draft.expiresAt) || draft.expiresAt < 0) {
    throw new Error("expiresAt must be a unix timestamp in seconds.");
  }

  return {
    version: FINAL_REQUEST_VERSION,
    requestId: parseFixedHex(draft.requestId, REQUEST_ID_BYTES, "requestId"),
    merchant: parseAddress(draft.merchant, "Merchant"),
    recipient: parseAddress(draft.recipient, "Recipient"),
    amountBaseUnits: draft.amountBaseUnits,
    memo,
    chainId: ARC_CHAIN_ID,
    expiresAt: draft.expiresAt,
    nonce: parseFixedHex(draft.nonce, NONCE_BYTES, "nonce"),
  };
}

/** Active while nowSeconds < expiresAt. Equal timestamps are already expired. */
export function assertFinalRequestActive(
  request: { expiresAt: number },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): void {
  if (!Number.isSafeInteger(request.expiresAt) || !Number.isSafeInteger(nowSeconds)) {
    throw new Error("expiresAt must be a unix timestamp in seconds.");
  }
  if (nowSeconds >= request.expiresAt) {
    throw new Error("Payment request has expired.");
  }
}

export function createUnsignedFinalRequest(input: CreateFinalRequestInput): UnsignedFinalRequest {
  return validateFinalRequest({
    version: FINAL_REQUEST_VERSION,
    requestId: input.requestId ?? generateRequestId(),
    merchant: input.merchant,
    recipient: input.recipient,
    amountBaseUnits: parseUsdcBaseUnits(input.amount),
    memo: input.memo.trim(),
    chainId: input.chainId ?? ARC_CHAIN_ID,
    expiresAt: input.expiresAt,
    nonce: input.nonce ?? generateNonce(),
  });
}

export function finalRequestTypedData(
  request: FinalRequestDraft,
  domain: FinalEip712Domain = FINAL_EIP712_DOMAIN,
): {
  domain: FinalEip712Domain;
  types: typeof FINAL_REQUEST_TYPES;
  primaryType: typeof FINAL_REQUEST_PRIMARY_TYPE;
  message: FinalRequestMessage;
} {
  const fields = validateFinalRequest(request);
  return {
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
    },
    types: FINAL_REQUEST_TYPES,
    primaryType: FINAL_REQUEST_PRIMARY_TYPE,
    message: {
      requestId: fields.requestId,
      recipient: fields.recipient,
      amountBaseUnits: fields.amountBaseUnits,
      memo: fields.memo,
      chainId: BigInt(fields.chainId),
      expiresAt: BigInt(fields.expiresAt),
      nonce: fields.nonce,
    },
  };
}

function asAccount(signer: Hex | PrivateKeyAccount): PrivateKeyAccount {
  if (typeof signer === "string") return privateKeyToAccount(signer);
  return signer;
}

export async function signFinalRequest(
  request: UnsignedFinalRequest,
  signer: Hex | PrivateKeyAccount,
): Promise<FinalRequest> {
  const fields = validateFinalRequest(request);
  const account = asAccount(signer);
  if (account.address !== fields.merchant) {
    throw new Error("Merchant must match the signing account.");
  }
  const typed = finalRequestTypedData(fields);
  const signature = await account.signTypedData(typed);
  return { ...fields, signature };
}

export async function recoverFinalRequestSigner(
  request: FinalRequest,
  domain: FinalEip712Domain = FINAL_EIP712_DOMAIN,
): Promise<Address> {
  if (!isHex(request.signature, { strict: true })) {
    throw new Error("Signature must be a hex string.");
  }
  const typed = finalRequestTypedData(request, domain);
  return recoverTypedDataAddress({
    ...typed,
    signature: request.signature,
  });
}

/**
 * True only when the EIP-712 signature recovers to request.merchant.
 * Field or domain changes fail closed. Does not check expiry.
 */
export async function verifyFinalRequest(
  request: FinalRequest,
  domain: FinalEip712Domain = FINAL_EIP712_DOMAIN,
): Promise<boolean> {
  try {
    const signer = await recoverFinalRequestSigner(request, domain);
    return signer === getAddress(request.merchant);
  } catch {
    return false;
  }
}
