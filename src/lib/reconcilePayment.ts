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
  notifyPaid?: (row: PayRecord) => void;
};

/**
 * Open row, no proof: the same unpaid row.
 * Open row, proof: the paid row from markPaid.
 * paidTx or cancelled: returned as stored. The scan is not called.
 * A thrown lookup or store write is not an unpaid row.
 */
export async function reconcilePaymentRecord(row: PayRecord, deps: ReconcileDeps): Promise<PayRecord> {
  if (row.paidTx || row.cancelled) return row;
  const lookup = lookupFromRecord(row);
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
