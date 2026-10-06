import { lookupFromRecord, type PaidLookup } from "./payPaid";
import type { PaidProof, PayRecord } from "./payStore";

/** Safe client text. Never include a provider URL, credential, or raw error. */
export const PAYMENT_STATUS_UNAVAILABLE = "Unable to verify payment status.";

/**
 * Thrown when a settlement check or the write that records it cannot finish.
 * The message is fixed so a provider error is not copied through.
 */
export class PaymentStatusUnavailableError extends Error {
  constructor() {
    super(PAYMENT_STATUS_UNAVAILABLE);
    this.name = "PaymentStatusUnavailableError";
  }
}

export type ReconcileDeps = {
  findSettlementProof: (lookup: PaidLookup) => Promise<PaidProof | null>;
  markPaid: (token: string, proof: PaidProof) => Promise<PayRecord | null>;
  /** Optional. Phase 14 prefers settleAndEnqueue for payment.paid; tests may omit. */
  notifyPaid?: (row: PayRecord) => void;
};

/**
 * Low-level reconcile helper: scan → markPaid.
 * Phase 14 HTTP paths use settlement.submitTransactionHash / reconcileOnePayment
 * instead. This remains for unit tests and any caller that injects markPaid.
 *
 * Open row, no proof: the same unpaid row.
 * Open row, proof: the paid row from markPaid.
 * paidTx: returned as stored. The scan is not called.
 * Cancelled rows are still scanned here only when the caller wants supersede
 * semantics via markPaid/nextPaidRecord (payment-before-cancel).
 * A thrown lookup or store write is not an unpaid row.
 */
export async function reconcilePaymentRecord(row: PayRecord, deps: ReconcileDeps): Promise<PayRecord> {
  if (row.paidTx) return row;
  const lookup = lookupFromRecord({
    token: row.token,
    to: row.to,
    amount: row.amount,
    memo: row.memo,
    // Ignore store cancelled so payment-before-cancel can still find a proof;
    // nextPaidRecord / settleRecord enforce cancel ordering.
    cancelled: false,
  });
  if (!lookup) return row;
  let proof: PaidProof | null;
  try {
    proof = await deps.findSettlementProof(lookup);
  } catch {
    throw new PaymentStatusUnavailableError();
  }
  if (!proof) return row;
  let updated: PayRecord | null;
  try {
    updated = await deps.markPaid(row.token, proof);
  } catch {
    throw new PaymentStatusUnavailableError();
  }
  if (!updated || updated.paidTx !== proof.tx) return updated ?? row;
  deps.notifyPaid?.(updated);
  return updated;
}
