/**
 * Phase 14 settlement orchestration.
 *
 * Submitted-hash verification + atomic settle + durable payment.paid enqueue.
 * Payment GETs must not call into this module for side effects.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Address, Hash } from "viem";
import {
  findSettlementProof,
  lookupFromRecord,
  proofFromTransactionHash,
  type PaidLookup,
  type SubmittedProofResult,
} from "./payPaid";
import {
  addSubmittedHash,
  applySettlementToStore,
  mutatePayStoreBlob,
  settleRecord,
  type PaidProof,
  type PayRecord,
  type SettleApplyResult,
  type StoreFile,
} from "./payStore";
import {
  paymentRequestEventData,
  processDueWebhookDeliveries,
  type WebhookDeliveryRecord,
  type WebhookEndpointRecord,
  type WebhookEnvelope,
} from "./webhooks";
import type { EmittableWebhookEvent } from "./webhooksCatalog";

export const MAX_SUBMIT_CANDIDATES = 3;

/** Deterministic event id so CAS retries do not enqueue duplicate payment.paid rows. */
export function paymentPaidEventId(row: PayRecord, paidTx: string): string {
  const id = (row.id || row.token).toLowerCase();
  const tx = paidTx.toLowerCase();
  const digest = createHash("sha256").update(`${id}:${tx}`).digest("hex").slice(0, 32);
  return `evt_paid_${digest}`;
}

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function asEndpoint(value: unknown): WebhookEndpointRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as WebhookEndpointRecord;
  if (typeof row.id !== "string" || typeof row.merchant !== "string") return null;
  if (typeof row.url !== "string" || typeof row.enabled !== "boolean") return null;
  if (!Array.isArray(row.events)) return null;
  return row;
}

function webhookSection(store: StoreFile): { endpoints: Record<string, unknown>; deliveries: Record<string, unknown> } {
  if (!store.webhooks) {
    store.webhooks = { endpoints: {}, deliveries: {} };
  }
  if (!store.webhooks.endpoints || typeof store.webhooks.endpoints !== "object") {
    store.webhooks.endpoints = {};
  }
  if (!store.webhooks.deliveries || typeof store.webhooks.deliveries !== "object") {
    store.webhooks.deliveries = {};
  }
  return store.webhooks as { endpoints: Record<string, unknown>; deliveries: Record<string, unknown> };
}

function hasDelivery(wh: { deliveries: Record<string, unknown> }, eventId: string, webhookId: string): boolean {
  for (const value of Object.values(wh.deliveries)) {
    if (!value || typeof value !== "object") continue;
    const row = value as WebhookDeliveryRecord;
    if (row.eventId === eventId && row.webhookId === webhookId && row.attempt === 1) return true;
  }
  return false;
}

/**
 * Enqueue payment.paid pending deliveries into the same store blob.
 * Returns newly inserted delivery ids (empty when already enqueued / no subscribers).
 */
export function enqueuePaymentPaidInStore(
  store: StoreFile,
  row: PayRecord,
  paidTx: Hash,
  nowSeconds: number,
): string[] {
  if (!row.paidTx || !sameHex(row.paidTx, paidTx)) return [];
  const eventId = paymentPaidEventId(row, paidTx);
  const merchant = row.to;
  const envelope: WebhookEnvelope = {
    id: eventId,
    type: "payment.paid" as EmittableWebhookEvent,
    createdAt: new Date(nowSeconds * 1000).toISOString(),
    merchant,
    data: {
      ...paymentRequestEventData(row),
      paidTx,
      phase: "PAID",
    },
  };
  const rawBody = JSON.stringify(envelope);
  const wh = webhookSection(store);
  const inserted: string[] = [];
  for (const value of Object.values(wh.endpoints)) {
    const endpoint = asEndpoint(value);
    if (!endpoint || !endpoint.enabled) continue;
    if (endpoint.merchant.toLowerCase() !== merchant.toLowerCase()) continue;
    if (!endpoint.events.includes("payment.paid")) continue;
    if (hasDelivery(wh, eventId, endpoint.id)) continue;
    const deliveryId = `dlv_${randomBytes(12).toString("hex")}`;
    const delivery: WebhookDeliveryRecord = {
      deliveryId,
      eventId,
      eventType: "payment.paid",
      webhookId: endpoint.id,
      merchant: endpoint.merchant,
      attempt: 1,
      status: "pending",
      httpStatus: null,
      createdAt: envelope.createdAt,
      attemptedAt: null,
      nextRetryAt: null,
      error: null,
      body: rawBody,
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    wh.deliveries[deliveryId] = delivery;
    inserted.push(deliveryId);
  }
  return inserted;
}

export type SettleWithWebhookResult = SettleApplyResult & {
  deliveryIds: string[];
  eventId: string | null;
};

/**
 * Atomic settle + durable payment.paid outbox in one CAS.
 * Emits logical payment.paid exactly once per (request, paidTx).
 */
export async function settleAndEnqueue(
  token: string,
  proof: PaidProof,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SettleWithWebhookResult> {
  let outcome: SettleApplyResult = { ok: false, code: "not_found", record: null };
  let deliveryIds: string[] = [];
  let eventId: string | null = null;
  await mutatePayStoreBlob((store) => {
    deliveryIds = [];
    eventId = null;
    outcome = applySettlementToStore(store, token, proof);
    if (outcome.ok && outcome.transitioned && outcome.record?.paidTx) {
      eventId = paymentPaidEventId(outcome.record, outcome.record.paidTx);
      deliveryIds = enqueuePaymentPaidInStore(store, outcome.record, outcome.record.paidTx, nowSeconds);
    }
  });
  return { ...outcome, deliveryIds, eventId };
}

/** Schedule first delivery attempt without blocking the HTTP response. */
export function schedulePaymentPaidKick(): void {
  const run = () => {
    void processDueWebhookDeliveries().catch(() => {
      /* first-attempt best effort; durable rows remain for cron */
    });
  };
  try {
    // next/server `after` keeps the work alive after the response on Vercel.
    // Dynamic import avoids pulling Next into unit tests that only import settlement helpers.
    void import("next/server")
      .then((mod) => {
        if (typeof mod.after === "function") mod.after(run);
        else run();
      })
      .catch(() => run());
  } catch {
    run();
  }
}

export type SubmitOutcome =
  | { kind: "paid"; record: PayRecord; transitioned: boolean }
  | { kind: "candidate"; record: PayRecord; reason: "not_found" | "rpc_unavailable" | "reverted" | "mismatch" | "pending" }
  | { kind: "rejected"; status: number; error: string; code: string; record?: PayRecord | null }
  | { kind: "unavailable" };

/**
 * Public submit path: persist candidate, verify by hash, settle if proof matches.
 * Never marks PAID on hash alone.
 */
export async function submitTransactionHash(input: {
  token: string;
  txHash: Hash;
  row: PayRecord;
  lookup: PaidLookup;
  nowSeconds?: number;
  verify?: typeof proofFromTransactionHash;
  settle?: typeof settleAndEnqueue;
  addCandidate?: typeof addSubmittedHash;
}): Promise<SubmitOutcome> {
  const verify = input.verify ?? proofFromTransactionHash;
  const settle = input.settle ?? settleAndEnqueue;
  const addCandidate = input.addCandidate ?? addSubmittedHash;
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (input.row.paidTx && sameHex(input.row.paidTx, input.txHash)) {
    return { kind: "paid", record: input.row, transitioned: false };
  }
  if (input.row.paidTx) {
    return {
      kind: "rejected",
      status: 409,
      error: "Payment already settled with a different transaction.",
      code: "already_paid_different",
      record: input.row,
    };
  }

  const candidates = input.row.submittedHashes ?? [];
  const already = candidates.some((h) => sameHex(h, input.txHash));
  if (!already && candidates.length >= MAX_SUBMIT_CANDIDATES) {
    return {
      kind: "rejected",
      status: 409,
      error: "Too many submitted transaction hashes for this payment.",
      code: "candidate_limit",
      record: input.row,
    };
  }

  let row = input.row;
  if (!already) {
    const updated = await addCandidate(input.token, input.txHash);
    if (updated) row = updated;
  }

  const verified: SubmittedProofResult = await verify(input.lookup, input.txHash);
  if (verified.status === "proof") {
    const settled = await settle(input.token, verified.proof, nowSeconds);
    if (settled.ok && settled.record?.paidTx) {
      if (settled.transitioned) schedulePaymentPaidKick();
      return { kind: "paid", record: settled.record, transitioned: settled.transitioned };
    }
    if (!settled.ok && settled.code === "settlement_used") {
      return {
        kind: "rejected",
        status: 409,
        error: "Transaction already settles another payment request.",
        code: "settlement_used",
        record: settled.record,
      };
    }
    if (!settled.ok && settled.code === "duplicate_request") {
      return {
        kind: "rejected",
        status: 409,
        error: "This requestId is already settled on another row.",
        code: "duplicate_request",
        record: settled.record,
      };
    }
    if (!settled.ok && settled.code === "late_settlement") {
      return {
        kind: "rejected",
        status: 409,
        error: "Settlement was mined at or after cancellation.",
        code: "late_settlement",
        record: settled.record,
      };
    }
    if (!settled.ok && settled.code === "already_paid_different") {
      return {
        kind: "rejected",
        status: 409,
        error: "Payment already settled with a different transaction.",
        code: "already_paid_different",
        record: settled.record,
      };
    }
    // Proof matched chain rules but store rejected (e.g. expired edge) — keep candidate.
    return { kind: "candidate", record: row, reason: "mismatch" };
  }
  if (verified.status === "rpc_unavailable") {
    return { kind: "candidate", record: row, reason: "rpc_unavailable" };
  }
  if (verified.status === "not_found") {
    return { kind: "candidate", record: row, reason: "not_found" };
  }
  if (verified.status === "reverted") {
    return { kind: "candidate", record: row, reason: "reverted" };
  }
  return { kind: "candidate", record: row, reason: "mismatch" };
}

export type ReconcileOutcome =
  | { kind: "paid"; record: PayRecord; transitioned: boolean }
  | { kind: "unchanged"; record: PayRecord }
  | { kind: "unavailable" }
  | { kind: "rejected"; status: number; error: string; code: string; record?: PayRecord | null };

/**
 * Authenticated single-row reconcile: candidates first, optional explicit hash,
 * then bounded lookback scan fallback.
 */
export async function reconcileOnePayment(input: {
  row: PayRecord;
  optionalTxHash?: Hash;
  allowScan?: boolean;
  nowSeconds?: number;
  verify?: typeof proofFromTransactionHash;
  findProof?: typeof findSettlementProof;
  settle?: typeof settleAndEnqueue;
}): Promise<ReconcileOutcome> {
  const verify = input.verify ?? proofFromTransactionHash;
  const findProof = input.findProof ?? findSettlementProof;
  const settle = input.settle ?? settleAndEnqueue;
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const row = input.row;

  if (row.paidTx) return { kind: "paid", record: row, transitioned: false };

  const lookup = lookupFromRecord({
    token: row.token,
    to: row.to,
    amount: row.amount,
    memo: row.memo,
    cancelled: false, // settle enforces cancel ordering
  });
  if (!lookup) return { kind: "unchanged", record: row };

  const hashes: Hash[] = [];
  if (input.optionalTxHash) hashes.push(input.optionalTxHash);
  for (const h of row.submittedHashes ?? []) {
    if (!hashes.some((x) => sameHex(x, h))) hashes.push(h);
  }

  for (const hash of hashes.slice(0, MAX_SUBMIT_CANDIDATES)) {
    let verified: SubmittedProofResult;
    try {
      verified = await verify(lookup, hash);
    } catch {
      return { kind: "unavailable" };
    }
    if (verified.status === "rpc_unavailable") return { kind: "unavailable" };
    if (verified.status !== "proof") continue;
    const settled = await settle(row.token, verified.proof, nowSeconds);
    if (settled.ok && settled.record?.paidTx) {
      if (settled.transitioned) schedulePaymentPaidKick();
      return { kind: "paid", record: settled.record, transitioned: settled.transitioned };
    }
    if (!settled.ok && settled.code === "settlement_used") {
      return {
        kind: "rejected",
        status: 409,
        error: "Transaction already settles another payment request.",
        code: "settlement_used",
        record: settled.record,
      };
    }
    if (!settled.ok && settled.code === "late_settlement") {
      return {
        kind: "rejected",
        status: 409,
        error: "Settlement was mined at or after cancellation.",
        code: "late_settlement",
        record: settled.record,
      };
    }
  }

  if (!input.allowScan) return { kind: "unchanged", record: row };

  let proof: PaidProof | null;
  try {
    proof = await findProof(lookup);
  } catch {
    return { kind: "unavailable" };
  }
  if (!proof) return { kind: "unchanged", record: row };

  const settled = await settle(row.token, proof, nowSeconds);
  if (settled.ok && settled.record?.paidTx) {
    if (settled.transitioned) schedulePaymentPaidKick();
    return { kind: "paid", record: settled.record, transitioned: settled.transitioned };
  }
  if (!settled.ok && settled.code === "settlement_used") {
    return {
      kind: "rejected",
      status: 409,
      error: "Transaction already settles another payment request.",
      code: "settlement_used",
      record: settled.record,
    };
  }
  if (!settled.ok && settled.code === "late_settlement") {
    return {
      kind: "rejected",
      status: 409,
      error: "Settlement was mined at or after cancellation.",
      code: "late_settlement",
      record: settled.record,
    };
  }
  return { kind: "unchanged", record: settled.record ?? row };
}

/** @deprecated Prefer settleAndEnqueue. Thin wrapper kept for older call sites. */
export async function settleOnly(token: string, proof: PaidProof): Promise<SettleApplyResult> {
  return settleRecord(token, proof);
}

export type { Address };
