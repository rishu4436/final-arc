import { decideCancellation, type CancelDecision } from "./finalCancel";
import { isV2PaidLookup, type PaidLookup, type PayIdentity } from "./payPaid";
import type { CancelCommand, PaidProof, PayRecord } from "./payStore";

export type CancelResolution =
  | { ok: false; status: number; error: string }
  | { ok: true; record: PayRecord; notify: "paid" | "cancelled" | null };

/**
 * Store and chain ports used by the cancel route.
 * The settlement function is the existing finder. This module does not
 * reimplement receipt rules.
 */
export type CancellationDeps = {
  getRecord: (token: string) => Promise<PayRecord | null>;
  markPaid: (token: string, proof: PaidProof) => Promise<PayRecord | null>;
  markCancelled: (token: string, command: CancelCommand) => Promise<PayRecord | null>;
  findSettlementProof: (lookup: PaidLookup) => Promise<PaidProof | null>;
  /** Insert the open row when a proof exists but the link was never registered. */
  ensureRecord: () => Promise<PayRecord>;
};

function expiredDecision(decision: CancelDecision): boolean {
  return !decision.ok && decision.status === 409 && decision.error === "Payment request has expired.";
}

/**
 * A valid on-chain settlement wins over cancellation.
 * Authorization is decideCancellation, unchanged. A failed authorization
 * does not scan, except an expired V2 request: an in-time settlement
 * (block timestamp already checked by the existing finder) is returned
 * as PAID instead of 409. No settlement still returns that 409, and the
 * row is not cancelled.
 *
 * Already-cancelled rows are not revived. Already-paid rows are returned
 * unchanged.
 *
 * Not atomic. findSettlementProof and markCancelled are separate steps.
 * A settlement that lands after a null scan, or another writer, can still
 * change the row. Redis REST has no compare-and-set. This does not claim one.
 */
export async function resolveCancellation(
  input: {
    token: string;
    identity: PayIdentity;
    lookup: PaidLookup | null;
    address?: string;
    signature?: string;
    nowSeconds: number;
  },
  deps: CancellationDeps,
): Promise<CancelResolution> {
  const request = input.lookup && isV2PaidLookup(input.lookup) ? input.lookup.request : undefined;
  const decision = await decideCancellation({
    version: input.identity.version,
    payee: input.identity.to,
    request,
    address: input.address,
    signature: input.signature,
    nowSeconds: input.nowSeconds,
  });

  if (!decision.ok) {
    if (expiredDecision(decision) && request) {
      const credited = await creditInTimeSettlement(input.token, request, deps);
      if (credited) return credited;
    }
    return { ok: false, status: decision.status, error: decision.error };
  }

  if (decision.version === 2 && request) {
    const credited = await creditInTimeSettlement(input.token, request, deps);
    if (credited) return credited;
  }

  // Null scan, then cancel. A settlement mined in this gap is not seen.
  // That race remains. Do not treat this write as atomic with the chain.
  return commitCancellation(input.token, decision, deps);
}

async function creditInTimeSettlement(
  token: string,
  request: Extract<PaidLookup, { version: 2 }>["request"],
  deps: CancellationDeps,
): Promise<CancelResolution | null> {
  const row = await deps.getRecord(token);
  if (row?.cancelled) return null;
  if (row?.paidTx) return { ok: true, record: row, notify: null };
  const proof = await deps.findSettlementProof({ version: 2, request, cancelled: false });
  if (!proof) return null;
  if (!row) await deps.ensureRecord();
  const paid = await deps.markPaid(token, proof);
  if (!paid?.paidTx) {
    throw new Error("Payment settlement could not be recorded.");
  }
  return { ok: true, record: paid, notify: "paid" };
}

async function commitCancellation(
  token: string,
  decision: Extract<CancelDecision, { ok: true }>,
  deps: CancellationDeps,
): Promise<CancelResolution> {
  const command: CancelCommand =
    decision.version === 1
      ? { version: 1, payee: decision.payee }
      : {
          version: 2,
          requestId: decision.requestId,
          nowSeconds: decision.nowSeconds,
          expiresAt: decision.expiresAt,
        };
  const row = await deps.markCancelled(token, command);
  if (!row) {
    return {
      ok: false,
      status: 403,
      error:
        decision.version === 2
          ? "Only the merchant can cancel this request."
          : "Only the payee can cancel this link.",
    };
  }
  if (row.paidTx) return { ok: true, record: row, notify: null };
  return { ok: true, record: row, notify: "cancelled" };
}
