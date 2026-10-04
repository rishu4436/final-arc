import {
  getAddress,
  isAddress,
  isHex,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ARC_CHAIN_ID } from "./arc";
import { type FinalRequest } from "./finalRequest";

/**
 * Cancellation domain. Name is not "FINAL" / PaymentRequest, so a payment
 * signature cannot be replayed as a cancellation or the reverse.
 * No verifyingContract: FINAL still has no protocol contract.
 */
export const FINAL_CANCEL_DOMAIN = {
  name: "FINAL Cancellation",
  version: "2",
  chainId: ARC_CHAIN_ID,
} as const;

export const FINAL_CANCEL_PRIMARY_TYPE = "CancelPaymentRequest" as const;

export const FINAL_CANCEL_TYPES = {
  CancelPaymentRequest: [
    { name: "requestId", type: "bytes16" },
    { name: "chainId", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type CancellationMessage = {
  requestId: Hex;
  chainId: bigint;
  nonce: Hex;
};

type CancelIdentity = Pick<FinalRequest, "requestId" | "chainId" | "nonce" | "merchant" | "expiresAt">;

export function cancellationTypedData(request: CancelIdentity): {
  domain: typeof FINAL_CANCEL_DOMAIN;
  types: typeof FINAL_CANCEL_TYPES;
  primaryType: typeof FINAL_CANCEL_PRIMARY_TYPE;
  message: CancellationMessage;
} {
  return {
    domain: FINAL_CANCEL_DOMAIN,
    types: FINAL_CANCEL_TYPES,
    primaryType: FINAL_CANCEL_PRIMARY_TYPE,
    message: {
      requestId: request.requestId,
      chainId: BigInt(request.chainId),
      nonce: request.nonce,
    },
  };
}

function asAccount(signer: Hex | PrivateKeyAccount): PrivateKeyAccount {
  if (typeof signer === "string") return privateKeyToAccount(signer);
  return signer;
}

/** Merchant signs requestId + chainId + nonce. The recipient is not the signer. */
export async function signPaymentCancellation(
  request: CancelIdentity,
  signer: Hex | PrivateKeyAccount,
): Promise<Hex> {
  const account = asAccount(signer);
  if (getAddress(account.address) !== getAddress(request.merchant)) {
    throw new Error("Merchant must match the signing account.");
  }
  return account.signTypedData(cancellationTypedData(request));
}

export async function recoverCancellationSigner(
  request: CancelIdentity,
  signature: Hex,
): Promise<Address> {
  if (!isHex(signature, { strict: true })) {
    throw new Error("Signature must be a hex string.");
  }
  const typed = cancellationTypedData(request);
  return recoverTypedDataAddress({ ...typed, signature });
}

/** True only when the signature recovers to request.merchant. */
export async function verifyPaymentCancellation(
  request: CancelIdentity,
  signature: Hex,
): Promise<boolean> {
  try {
    const signer = await recoverCancellationSigner(request, signature);
    return signer === getAddress(request.merchant);
  } catch {
    return false;
  }
}

export type CancelDecision =
  | { ok: true; version: 1; payee: Address }
  | { ok: true; version: 2; requestId: Hex; nowSeconds: number; expiresAt: number }
  | { ok: false; status: number; error: string };

/**
 * V1 stays address-based: the connected payee must equal the recipient.
 * That is legacy and is not a V2-grade signature.
 * V2 ignores the supplied address. Only the merchant cancellation signature
 * authorizes it, and it is bound to this request's id, chain, and nonce.
 */
export async function decideCancellation(input: {
  version: 1 | 2;
  payee: Address;
  request?: CancelIdentity;
  address?: string;
  signature?: string;
  nowSeconds: number;
}): Promise<CancelDecision> {
  if (input.version === 1) {
    if (!input.address || !isAddress(input.address, { strict: false })) {
      return { ok: false, status: 401, error: "Connect the payee wallet to cancel." };
    }
    const signer = getAddress(input.address);
    if (signer !== getAddress(input.payee)) {
      return { ok: false, status: 403, error: "Only the payee can cancel this link." };
    }
    return { ok: true, version: 1, payee: signer };
  }

  const request = input.request;
  if (!request || typeof request.expiresAt !== "number") {
    return { ok: false, status: 400, error: "Invalid payment request." };
  }
  if (input.nowSeconds >= request.expiresAt) {
    return { ok: false, status: 409, error: "Payment request has expired." };
  }
  if (!input.signature || !isHex(input.signature, { strict: true })) {
    return { ok: false, status: 401, error: "V2 cancellation requires the merchant's signature." };
  }
  const ok = await verifyPaymentCancellation(request, input.signature);
  if (!ok) {
    return { ok: false, status: 403, error: "Cancellation signature is not the merchant." };
  }
  return {
    ok: true,
    version: 2,
    requestId: request.requestId,
    nowSeconds: input.nowSeconds,
    expiresAt: request.expiresAt,
  };
}
