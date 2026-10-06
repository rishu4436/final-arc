import { decideCancellation, type CancelDecision } from "./finalCancel";
import { isV2PaidLookup, type PaidLookup, type PayIdentity } from "./payPaid";
import type { CancelCommand, PayRecord } from "./payStore";

export type CancelResolution =
  | { ok: false; status: number; error: string }
  | { ok: true; record: PayRecord; notify: "paid" | "cancelled" | null };

/**
 * Store ports used by the cancel route.
 * Phase 14: cancellation does NOT scan the chain. Settlement discovery is
 * submit / merchant reconcile. Payment-before-cancel is enforced later when
 * a proof with blockTimestamp < cancelledAtSeconds is applied.
 */
export type CancellationDeps = {
  getRecord: (token: string) => Promise<PayRecord | null>;
  markCancelled: (token: string, command: CancelCommand) => Promise<PayRecord | null>;
  /** @deprecated Phase 14 cancel does not mark paid or scan. Accepted and ignored. */
  markPaid?: (token: string, proof: import("./payStore").PaidProof) => Promise<PayRecord | null>;
  /** @deprecated Phase 14 cancel does not scan. Accepted and ignored. */
  findSettlementProof?: (lookup: PaidLookup) => Promise<import("./payStore").PaidProof | null>;
  ensureRecord?: () => Promise<PayRecord>;
};

function expiredDecision(decision: CancelDecision): boolean {
  return !decision.ok && decision.status === 409 && decision.error === "Payment request has expired.";
}

/**
 * Authorize via decideCancellation, then persist cancel with cancelledAtSeconds.
 * No chain scan. Already-paid rows are returned unchanged (notify null).
 * Already-cancelled rows are returned unchanged.
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
    // Expired V2: do not cancel; do not scan. Caller may still have an in-time
    // settlement discoverable via submit/reconcile.
    if (expiredDecision(decision)) {
      const existing = await deps.getRecord(input.token);
      if (existing?.paidTx) return { ok: true, record: existing, notify: null };
    }
    return { ok: false, status: decision.status, error: decision.error };
  }

  return commitCancellation(input.token, decision, deps);
}

async function commitCancellation(
  token: string,
  decision: Extract<CancelDecision, { ok: true }>,
  deps: CancellationDeps,
): Promise<CancelResolution> {
  const existing = await deps.getRecord(token);
  if (existing?.paidTx) return { ok: true, record: existing, notify: null };
  if (existing?.cancelled) return { ok: true, record: existing, notify: null };

  const command: CancelCommand =
    decision.version === 1
      ? { version: 1, payee: decision.payee }
      : {
          version: 2,
          requestId: decision.requestId,
          nowSeconds: decision.nowSeconds,
          expiresAt: decision.expiresAt,
        };

  // Ensure row exists for V2 cancel of an unregistered-but-signed link only when
  // the caller provided ensureRecord (legacy behavior). Prefer registered rows.
  if (!existing && deps.ensureRecord) {
    await deps.ensureRecord();
  }

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
  if (!row.cancelled) {
    // Derived-expired V2 refuse-to-cancel path.
    return {
      ok: false,
      status: 409,
      error: "Payment request has expired.",
    };
  }
  return { ok: true, record: row, notify: "cancelled" };
}
