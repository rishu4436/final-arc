import type { Address, Hash } from "viem";
import { checkoutFacts } from "./checkoutState";
import { decodePayLink, paymentLinkPhase, type PayLinkPhase } from "./payRequest";
import type { PayRecord } from "./payStore";
import { isTxHash } from "./receipt";

/**
 * Public payer view of one payment link.
 * Read-only. This does not create a row, reconcile, or emit webhooks.
 * V1 leaves requestId null. nonce and memoId are not included.
 */
export type CheckoutObservation = {
  version: 1 | 2;
  phase: PayLinkPhase;
  amount: string;
  merchant: Address | null;
  recipient: Address;
  memo: string;
  expiresAt: number | null;
  cancelled: boolean;
  /** Set only when the stored paidTx is already a real transaction hash. */
  paidTx: Hash | null;
  /** V2 request id from the token. Null for V1. */
  requestId: string | null;
};

export type CheckoutObserveResult =
  | { status: 200; body: { observation: CheckoutObservation } }
  | { status: 404; body: { error: { code: "not_found"; message: string } } }
  | { status: 503; body: { error: { code: "unavailable"; message: string } } };

export type CheckoutObserveDeps = {
  getRecord: (token: string) => Promise<PayRecord | null>;
  nowSeconds?: number;
};

const NOT_FOUND = {
  status: 404 as const,
  body: { error: { code: "not_found" as const, message: "Unknown payment link." } },
};

const UNAVAILABLE = {
  status: 503 as const,
  body: {
    error: {
      code: "unavailable" as const,
      message: "Payment status is temporarily unavailable.",
    },
  },
};

/**
 * Look up one payment-link token. A missing row is the decoded request
 * (OPEN or EXPIRED) and is not written. PAID is only the stored paid flag.
 */
export async function observeCheckoutRecord(
  token: string,
  deps: CheckoutObserveDeps,
): Promise<CheckoutObserveResult> {
  const link = decodePayLink(token);
  if (!link) return NOT_FOUND;
  let row: PayRecord | null;
  try {
    row = await deps.getRecord(token);
  } catch {
    return UNAVAILABLE;
  }
  const facts = checkoutFacts(link);
  const storedPaidTx = row?.paidTx && isTxHash(row.paidTx) ? row.paidTx : null;
  const cancelled = row?.cancelled === true;
  const phase = paymentLinkPhase({
    paid: storedPaidTx != null,
    cancelled,
    expiresAt: facts.expiresAt,
    nowSeconds: deps.nowSeconds ?? Math.floor(Date.now() / 1000),
  });
  return {
    status: 200,
    body: {
      observation: {
        version: facts.version,
        phase,
        amount: facts.amount,
        merchant: facts.merchant,
        recipient: facts.recipient,
        memo: facts.memo,
        expiresAt: facts.expiresAt,
        cancelled,
        paidTx: storedPaidTx,
        requestId: facts.requestId,
      },
    },
  };
}
