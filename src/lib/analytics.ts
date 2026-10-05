import { getAddress, isAddress } from "viem";
import { buildMerchantDashboard, type DashboardRequestRow } from "./merchantDashboard";
import { readStoredPolicy, type PaymentPolicy } from "./paymentPolicy";
import type { StoreFile } from "./payStore";
import { committedForCap, type LedgerDoc, type LedgerReservation, type VerifiedSpendFact } from "./policyLedger";

/**
 * Phase 12 analytics. Pure, read-only aggregation.
 *
 * Input is an already-loaded pay-store blob (and, for policy reservations, an
 * already-read policy ledger document). Output is derived counts and base-unit
 * sums for ONE merchant. This module:
 * - never writes the store or the ledger, and never mutates its inputs
 * - never reads the chain, signs, or sends anything
 * - never reconciles: "recorded paid" is the stored paidTx and nothing else
 * - never reads the agent replay-cache section or the stale policies.reservations section
 * - never returns secrets, delivery bodies, raw delivery errors, payer
 *   addresses, agent names, client references, signatures, or proof contents
 *
 * The merchant argument must come from authentication. Every source below is
 * filtered by it.
 */

export const ANALYTICS_SECTIONS = ["payments", "agents", "policies", "webhooks", "escrows", "apiKeys"] as const;
export type AnalyticsSection = (typeof ANALYTICS_SECTIONS)[number];

export const TIMESERIES_METRICS = [
  "requests_created",
  "requested_volume",
  "agent_verified",
  "agent_verified_volume",
  "policy_denials",
] as const;
export type TimeseriesMetric = (typeof TIMESERIES_METRICS)[number];

export const TIMESERIES_GRANULARITIES = ["day", "hour"] as const;
export type TimeseriesGranularity = (typeof TIMESERIES_GRANULARITIES)[number];

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MAX_RANGE_DAYS: Record<TimeseriesGranularity, number> = { day: 366, hour: 7 };
export const MAX_OVERVIEW_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;

export const LABELS = {
  recordedPaid: "Recorded paid (stored paidTx). Not independently verified by analytics.",
  reservations: "Reserved / held — not funds",
  utilization: "Committed (verified + held) / cap",
  webhookRetention: "Last 100 deliveries per endpoint",
} as const;

/** Half-open UTC range [fromMs, toMs). */
export type AnalyticsRange = { fromMs: number; toMs: number };

export type Rate = { numerator: number; denominator: number; rate: number | null };
export type AmountBucket = { count: number; baseUnits: string };

const ESCROW_STATES = ["CREATED", "OPEN", "FUNDED", "RELEASED", "REFUNDED", "CANCELLED"] as const;
type EscrowStateName = (typeof ESCROW_STATES)[number];
const PROOF_STATUSES = ["VERIFIED", "PARTIAL", "INVALID", "NOT_FOUND", "UNAVAILABLE"] as const;
const RESERVATION_STATUSES = ["RESERVED", "CONSUMED", "RELEASED"] as const;
type ReservationStatusName = (typeof RESERVATION_STATUSES)[number];

const BASE_UNITS = /^(0|[1-9]\d*)$/;
const POSITIVE_BASE_UNITS = /^[1-9]\d*$/;

function rate(numerator: number, denominator: number): Rate {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function values(section: unknown): unknown[] {
  return isObject(section) ? Object.values(section) : [];
}

function sameAddress(left: unknown, right: string): boolean {
  if (typeof left !== "string" || !isAddress(left) || !isAddress(right)) return false;
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function inRange(ms: number, range: AnalyticsRange): boolean {
  return ms >= range.fromMs && ms < range.toMs;
}

function safeSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function amountOf(value: unknown, allowZero = false): bigint | null {
  if (typeof value !== "string") return null;
  if (!(allowZero ? BASE_UNITS : POSITIVE_BASE_UNITS).test(value)) return null;
  return BigInt(value);
}

function emptyBucket(): { count: number; sum: bigint } {
  return { count: 0, sum: 0n };
}

function bucketOut(bucket: { count: number; sum: bigint }): AmountBucket {
  return { count: bucket.count, baseUnits: bucket.sum.toString() };
}

// ---------------------------------------------------------------------------
// Payment requests (store.records). Owner: V2 decoded merchant, V1 `to`.
// Phase: paymentLinkPhase through buildMerchantDashboard (stored paidTx and
// cancelled, derived expiry). No reconciliation, no view registration.
// ---------------------------------------------------------------------------

export function merchantPaymentRows(store: StoreFile, merchant: string, nowSeconds: number): DashboardRequestRow[] {
  const model = buildMerchantDashboard({
    merchant,
    records: values(store.records),
    nowSeconds,
  });
  return model.locked ? [] : model.rows;
}

export type PaymentAnalytics = {
  basis: "createdAt";
  label: string;
  total: number;
  open: number;
  recordedPaid: number;
  expired: number;
  cancelled: number;
  requestedBaseUnits: string;
  recordedPaidBaseUnits: string;
  outstandingBaseUnits: string;
  averageRequestBaseUnits: string | null;
  completionRate: Rate;
  expirationRate: Rate;
  cancellationRate: Rate;
  byVersion: { v1: number; v2: number };
  missingCreatedAt: number;
};

export function paymentAnalytics(rows: readonly DashboardRequestRow[], range: AnalyticsRange): PaymentAnalytics {
  let total = 0;
  let open = 0;
  let paid = 0;
  let expired = 0;
  let cancelled = 0;
  let requested = 0n;
  let paidSum = 0n;
  let outstanding = 0n;
  let missingCreatedAt = 0;
  const byVersion = { v1: 0, v2: 0 };
  for (const row of rows) {
    const created = parseIsoMs(row.createdAt);
    if (created == null) {
      missingCreatedAt += 1;
      continue;
    }
    if (!inRange(created, range)) continue;
    total += 1;
    requested += row.amountBaseUnits;
    if (row.version === 1) byVersion.v1 += 1;
    else byVersion.v2 += 1;
    if (row.status === "PAID") {
      paid += 1;
      paidSum += row.amountBaseUnits;
    } else if (row.status === "OPEN") {
      open += 1;
      outstanding += row.amountBaseUnits;
    } else if (row.status === "EXPIRED") {
      expired += 1;
    } else if (row.status === "CANCELLED") {
      cancelled += 1;
    }
  }
  return {
    basis: "createdAt",
    label: LABELS.recordedPaid,
    total,
    open,
    recordedPaid: paid,
    expired,
    cancelled,
    requestedBaseUnits: requested.toString(),
    recordedPaidBaseUnits: paidSum.toString(),
    outstandingBaseUnits: outstanding.toString(),
    averageRequestBaseUnits: total > 0 ? (requested / BigInt(total)).toString() : null,
    completionRate: rate(paid, total),
    expirationRate: rate(expired, total),
    cancellationRate: rate(cancelled, total),
    byVersion,
    missingCreatedAt,
  };
}

// ---------------------------------------------------------------------------
// Agent intents (store.agents.intents) only; the agent replay cache is never read.
// EXPIRED is derived like agentPayments.publicStatus: only while stored status
// is AWAITING_PAYMENT and now >= the joined V2 request expiresAt.
// ---------------------------------------------------------------------------

type IntentView = {
  id: string;
  createdMs: number | null;
  status: "AWAITING_PAYMENT" | "SUBMITTED" | "VERIFIED" | "FAILED" | "EXPIRED";
  proofStatus: (typeof PROOF_STATUSES)[number] | null;
  verifiedAt: number | null;
  amount: bigint | null;
  awaitingUnjoined: boolean;
};

function v2Index(rows: readonly DashboardRequestRow[]): Map<string, DashboardRequestRow> {
  const map = new Map<string, DashboardRequestRow>();
  for (const row of rows) {
    if (row.version === 2 && row.requestId) map.set(row.requestId.toLowerCase(), row);
  }
  return map;
}

export function merchantIntents(
  store: StoreFile,
  merchant: string,
  rows: readonly DashboardRequestRow[],
  nowSeconds: number,
): { intents: IntentView[]; malformed: number } {
  const index = v2Index(rows);
  const intents: IntentView[] = [];
  let malformed = 0;
  for (const [key, value] of Object.entries(isObject(store.agents?.intents) ? store.agents.intents : {})) {
    if (!isObject(value)) continue;
    if (!sameAddress(value.merchant, merchant)) continue;
    const stored = value.status;
    if (stored !== "AWAITING_PAYMENT" && stored !== "SUBMITTED" && stored !== "VERIFIED" && stored !== "FAILED") {
      malformed += 1;
      continue;
    }
    const id = typeof value.intentId === "string" ? value.intentId : key;
    const requestId = typeof value.requestId === "string" ? value.requestId.toLowerCase() : null;
    const request = requestId ? index.get(requestId) : undefined;
    let status: IntentView["status"] = stored;
    let awaitingUnjoined = false;
    if (stored === "AWAITING_PAYMENT") {
      if (request?.expiresAt != null) {
        if (nowSeconds >= request.expiresAt) status = "EXPIRED";
      } else {
        awaitingUnjoined = true;
      }
    }
    const proof = value.proofStatus;
    const proofStatus = (PROOF_STATUSES as readonly unknown[]).includes(proof)
      ? (proof as IntentView["proofStatus"])
      : null;
    let amount = amountOf(value.amountBaseUnits);
    if (amount == null && request) amount = request.amountBaseUnits;
    intents.push({
      id,
      createdMs: parseIsoMs(value.createdAt),
      status,
      proofStatus,
      verifiedAt: stored === "VERIFIED" ? safeSeconds(value.verifiedAt) : null,
      amount,
      awaitingUnjoined,
    });
  }
  return { intents, malformed };
}

export type AgentAnalytics = {
  basis: "createdAt";
  created: number;
  awaitingPayment: number;
  submitted: number;
  verified: number;
  failed: number;
  expired: number;
  /** AWAITING_PAYMENT rows whose V2 request is not in the store; expiry cannot be derived. */
  awaitingWithoutRequest: number;
  proofStatus: Record<(typeof PROOF_STATUSES)[number] | "NONE", number>;
  /** Verified by server verifiedAt within the range. SUBMITTED/PARTIAL/NOT_FOUND/UNAVAILABLE never count. */
  verifiedInRange: { basis: "verifiedAt"; count: number; baseUnits: string; missingAmount: number };
  verifiedMissingVerifiedAt: number;
  policyDenied: number;
  missingCreatedAt: number;
  malformed: number;
};

export function agentAnalytics(
  intents: readonly IntentView[],
  malformed: number,
  denialsInRange: number,
  range: AnalyticsRange,
): AgentAnalytics {
  const out: AgentAnalytics = {
    basis: "createdAt",
    created: 0,
    awaitingPayment: 0,
    submitted: 0,
    verified: 0,
    failed: 0,
    expired: 0,
    awaitingWithoutRequest: 0,
    proofStatus: { VERIFIED: 0, PARTIAL: 0, INVALID: 0, NOT_FOUND: 0, UNAVAILABLE: 0, NONE: 0 },
    verifiedInRange: { basis: "verifiedAt", count: 0, baseUnits: "0", missingAmount: 0 },
    verifiedMissingVerifiedAt: 0,
    policyDenied: denialsInRange,
    missingCreatedAt: 0,
    malformed,
  };
  let verifiedSum = 0n;
  for (const intent of intents) {
    if (intent.status === "VERIFIED") {
      if (intent.verifiedAt == null) {
        out.verifiedMissingVerifiedAt += 1;
      } else if (inRange(intent.verifiedAt * 1000, range)) {
        out.verifiedInRange.count += 1;
        if (intent.amount == null) out.verifiedInRange.missingAmount += 1;
        else verifiedSum += intent.amount;
      }
    }
    if (intent.createdMs == null) {
      out.missingCreatedAt += 1;
      continue;
    }
    if (!inRange(intent.createdMs, range)) continue;
    out.created += 1;
    if (intent.status === "AWAITING_PAYMENT") out.awaitingPayment += 1;
    else if (intent.status === "SUBMITTED") out.submitted += 1;
    else if (intent.status === "VERIFIED") out.verified += 1;
    else if (intent.status === "FAILED") out.failed += 1;
    else if (intent.status === "EXPIRED") out.expired += 1;
    if (intent.awaitingUnjoined) out.awaitingWithoutRequest += 1;
    out.proofStatus[intent.proofStatus ?? "NONE"] += 1;
  }
  out.verifiedInRange.baseUnits = verifiedSum.toString();
  return out;
}

// ---------------------------------------------------------------------------
// Policies (store.policies.records, store.policies.denials). Never
// store.policies.reservations: the Redis ledger is authoritative.
// ---------------------------------------------------------------------------

type DenialView = { evaluatedMs: number; codes: string[]; policyIds: (string | null)[] };

export function merchantPolicies(store: StoreFile, merchant: string): { policies: PaymentPolicy[]; malformed: number } {
  const policies: PaymentPolicy[] = [];
  let malformed = 0;
  for (const value of values(store.policies?.records)) {
    if (!isObject(value) || !sameAddress(value.merchant, merchant)) continue;
    const policy = readStoredPolicy(value);
    if (!policy) {
      malformed += 1;
      continue;
    }
    policies.push(policy);
  }
  return { policies, malformed };
}

export function merchantDenials(store: StoreFile, merchant: string): { denials: DenialView[]; malformed: number } {
  const denials: DenialView[] = [];
  let malformed = 0;
  for (const value of values(store.policies?.denials)) {
    if (!isObject(value) || !sameAddress(value.merchant, merchant)) continue;
    const seconds = safeSeconds(value.evaluatedAt);
    const evaluatedMs = seconds != null ? seconds * 1000 : parseIsoMs(value.createdAt);
    if (evaluatedMs == null || !Array.isArray(value.reasons)) {
      malformed += 1;
      continue;
    }
    const codes: string[] = [];
    const policyIds: (string | null)[] = [];
    for (const reason of value.reasons) {
      if (!isObject(reason) || typeof reason.code !== "string") continue;
      codes.push(reason.code);
      policyIds.push(typeof reason.policyId === "string" ? reason.policyId : null);
    }
    denials.push({ evaluatedMs, codes, policyIds });
  }
  return { denials, malformed };
}

export type PolicyAnalytics = {
  total: number;
  enabled: number;
  disabled: number;
  malformed: number;
  withSpendCap: number;
  denials: {
    basis: "evaluatedAt";
    total: number;
    byCode: Record<string, number>;
    byPolicy: { policyId: string; name: string | null; count: number }[];
    unattributedReasons: number;
    malformed: number;
  };
};

export function policyAnalytics(
  policies: readonly PaymentPolicy[],
  malformedPolicies: number,
  denials: readonly DenialView[],
  malformedDenials: number,
  range: AnalyticsRange,
): PolicyAnalytics {
  const names = new Map(policies.map((p) => [p.id, p.name]));
  const byCode: Record<string, number> = {};
  const byPolicy = new Map<string, number>();
  let total = 0;
  let unattributed = 0;
  for (const denial of denials) {
    if (!inRange(denial.evaluatedMs, range)) continue;
    total += 1;
    for (const code of new Set(denial.codes)) byCode[code] = (byCode[code] ?? 0) + 1;
    const seen = new Set<string>();
    for (const policyId of denial.policyIds) {
      if (policyId == null) {
        unattributed += 1;
        continue;
      }
      if (seen.has(policyId)) continue;
      seen.add(policyId);
      byPolicy.set(policyId, (byPolicy.get(policyId) ?? 0) + 1);
    }
  }
  const enabled = policies.filter((p) => p.enabled).length;
  return {
    total: policies.length,
    enabled,
    disabled: policies.length - enabled,
    malformed: malformedPolicies,
    withSpendCap: policies.filter((p) => p.rules.maxSpendBaseUnits !== undefined).length,
    denials: {
      basis: "evaluatedAt",
      total,
      byCode,
      byPolicy: [...byPolicy.entries()]
        .map(([policyId, count]) => ({ policyId, name: names.get(policyId) ?? null, count }))
        .sort((a, b) => b.count - a.count || (a.policyId < b.policyId ? -1 : 1)),
      unattributedReasons: unattributed,
      malformed: malformedDenials,
    },
  };
}

/** Same rule as paymentPolicies.verifiedSpendFacts, re-stated here so analytics imports no write path. */
export function verifiedSpendFactsReadOnly(store: StoreFile, merchant: string): VerifiedSpendFact[] {
  const out: VerifiedSpendFact[] = [];
  for (const [key, value] of Object.entries(isObject(store.agents?.intents) ? store.agents.intents : {})) {
    if (!isObject(value) || value.status !== "VERIFIED") continue;
    if (!sameAddress(value.merchant, merchant)) continue;
    const verifiedAt = safeSeconds(value.verifiedAt);
    if (verifiedAt == null || typeof value.amountBaseUnits !== "string") continue;
    if (!POSITIVE_BASE_UNITS.test(value.amountBaseUnits)) continue;
    const id = typeof value.intentId === "string" ? value.intentId : key;
    out.push({ id, amountBaseUnits: value.amountBaseUnits, verifiedAt });
  }
  return out;
}

export type ReservationAnalytics =
  | {
      available: true;
      label: typeof LABELS.reservations;
      basis: "current_ledger_state";
      byStatus: Record<ReservationStatusName, AmountBucket>;
      byPolicy: { policyId: string; name: string | null; byStatus: Record<ReservationStatusName, AmountBucket> }[];
    }
  | { available: false; label: typeof LABELS.reservations; reason: "ledger_unavailable" };

export type UtilizationRow = {
  policyId: string;
  name: string;
  capBaseUnits: string;
  windowSeconds: number;
  label: typeof LABELS.utilization;
} & (
  | { available: true; committedBaseUnits: string; utilizationBps: number }
  | { available: false; committedBaseUnits: null; utilizationBps: null; reason: "ledger_unavailable" }
);

/** Only this merchant's rows, as a fresh object. The input doc is never modified. */
function merchantLedgerCopy(doc: LedgerDoc, merchant: string): LedgerDoc {
  const reservations: Record<string, LedgerReservation> = {};
  for (const [id, row] of Object.entries(doc.reservations ?? {})) {
    if (isObject(row) && sameAddress(row.merchant, merchant)) reservations[id] = { ...row, policyIds: [...(row.policyIds ?? [])] };
  }
  return { version: doc.version, reservations };
}

function statusBuckets(): Record<ReservationStatusName, { count: number; sum: bigint }> {
  return { RESERVED: emptyBucket(), CONSUMED: emptyBucket(), RELEASED: emptyBucket() };
}

function statusOut(b: Record<ReservationStatusName, { count: number; sum: bigint }>): Record<ReservationStatusName, AmountBucket> {
  return { RESERVED: bucketOut(b.RESERVED), CONSUMED: bucketOut(b.CONSUMED), RELEASED: bucketOut(b.RELEASED) };
}

/**
 * ledger === null means the ledger could not be read. That is reported as
 * unavailable, never as zero. Stored statuses are reported as stored; no lazy
 * recovery is applied and nothing is written back.
 */
export function reservationAnalytics(
  ledger: LedgerDoc | null,
  merchant: string,
  policies: readonly PaymentPolicy[],
): ReservationAnalytics {
  if (!ledger) return { available: false, label: LABELS.reservations, reason: "ledger_unavailable" };
  const doc = merchantLedgerCopy(ledger, merchant);
  const names = new Map(policies.map((p) => [p.id, p.name]));
  const total = statusBuckets();
  const perPolicy = new Map<string, ReturnType<typeof statusBuckets>>();
  for (const row of Object.values(doc.reservations)) {
    const status = row.status;
    if (!(RESERVATION_STATUSES as readonly string[]).includes(status)) continue;
    const amount = amountOf(row.amountBaseUnits);
    if (amount == null) continue;
    total[status].count += 1;
    total[status].sum += amount;
    for (const policyId of new Set(row.policyIds)) {
      if (typeof policyId !== "string") continue;
      const buckets = perPolicy.get(policyId) ?? statusBuckets();
      buckets[status].count += 1;
      buckets[status].sum += amount;
      perPolicy.set(policyId, buckets);
    }
  }
  return {
    available: true,
    label: LABELS.reservations,
    basis: "current_ledger_state",
    byStatus: statusOut(total),
    byPolicy: [...perPolicy.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([policyId, buckets]) => ({ policyId, name: names.get(policyId) ?? null, byStatus: statusOut(buckets) })),
  };
}

/** Enabled spend-cap policies only. Uses the authoritative committedForCap. */
export function utilizationAnalytics(
  ledger: LedgerDoc | null,
  merchant: string,
  policies: readonly PaymentPolicy[],
  verified: readonly VerifiedSpendFact[],
  nowSeconds: number,
): UtilizationRow[] {
  const doc = ledger ? merchantLedgerCopy(ledger, merchant) : null;
  const out: UtilizationRow[] = [];
  for (const policy of policies) {
    if (!policy.enabled) continue;
    const cap = amountOf(policy.rules.maxSpendBaseUnits);
    const windowSeconds = policy.rules.windowSeconds;
    if (cap == null || typeof windowSeconds !== "number") continue;
    const base = {
      policyId: policy.id,
      name: policy.name,
      capBaseUnits: cap.toString(),
      windowSeconds,
      label: LABELS.utilization,
    };
    if (!doc) {
      out.push({ ...base, available: false, committedBaseUnits: null, utilizationBps: null, reason: "ledger_unavailable" });
      continue;
    }
    const committed = committedForCap(doc, verified, nowSeconds, windowSeconds);
    out.push({
      ...base,
      available: true,
      committedBaseUnits: committed.toString(),
      utilizationBps: Number((committed * 10_000n) / cap),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Webhooks. Endpoint and delivery metadata only; never secret, body, or the
// raw error string. Deliveries are the retained window (last 100 per endpoint).
// ---------------------------------------------------------------------------

export type WebhookAnalytics = {
  retention: typeof LABELS.webhookRetention;
  basis: "createdAt";
  endpoints: { total: number; enabled: number; disabled: number };
  deliveries: {
    attempts: number;
    success: number;
    failed: number;
    retrying: number;
    retryAttempts: number;
    successRate: Rate;
    failureCategories: { "3xx": number; "4xx": number; "5xx": number; no_response: number; other: number };
  };
  malformed: number;
};

export function webhookAnalytics(store: StoreFile, merchant: string, range: AnalyticsRange): WebhookAnalytics {
  const owned = new Set<string>();
  const foreign = new Set<string>();
  let enabled = 0;
  let total = 0;
  for (const value of values(store.webhooks?.endpoints)) {
    if (!isObject(value) || typeof value.id !== "string") continue;
    if (!sameAddress(value.merchant, merchant)) {
      foreign.add(value.id);
      continue;
    }
    owned.add(value.id);
    total += 1;
    if (value.enabled === true) enabled += 1;
  }
  const out: WebhookAnalytics = {
    retention: LABELS.webhookRetention,
    basis: "createdAt",
    endpoints: { total, enabled, disabled: total - enabled },
    deliveries: {
      attempts: 0,
      success: 0,
      failed: 0,
      retrying: 0,
      retryAttempts: 0,
      successRate: rate(0, 0),
      failureCategories: { "3xx": 0, "4xx": 0, "5xx": 0, no_response: 0, other: 0 },
    },
    malformed: 0,
  };
  const d = out.deliveries;
  for (const value of values(store.webhooks?.deliveries)) {
    if (!isObject(value) || !sameAddress(value.merchant, merchant)) continue;
    if (typeof value.webhookId !== "string" || foreign.has(value.webhookId)) continue;
    const created = parseIsoMs(value.createdAt);
    const status = value.status;
    if (created == null || (status !== "success" && status !== "failed" && status !== "retrying")) {
      out.malformed += 1;
      continue;
    }
    if (!inRange(created, range)) continue;
    d.attempts += 1;
    if (typeof value.attempt === "number" && value.attempt > 1) d.retryAttempts += 1;
    if (status === "success") {
      d.success += 1;
      continue;
    }
    if (status === "failed") d.failed += 1;
    else d.retrying += 1;
    const http = typeof value.httpStatus === "number" && Number.isInteger(value.httpStatus) ? value.httpStatus : null;
    if (http == null) d.failureCategories.no_response += 1;
    else if (http >= 300 && http < 400) d.failureCategories["3xx"] += 1;
    else if (http >= 400 && http < 500) d.failureCategories["4xx"] += 1;
    else if (http >= 500 && http < 600) d.failureCategories["5xx"] += 1;
    else d.failureCategories.other += 1;
  }
  d.successRate = rate(d.success, d.attempts);
  return out;
}

// ---------------------------------------------------------------------------
// API keys. Public state only; never hash or secret. Current state, not ranged.
// ---------------------------------------------------------------------------

export type ApiKeyAnalytics = {
  basis: "current_state";
  total: number;
  active: number;
  disabled: number;
  revoked: number;
  expired: number;
  withAnalyticsScope: number;
  lastUsedAt: string | null;
};

export function apiKeyAnalytics(store: StoreFile, merchant: string, nowSeconds: number): ApiKeyAnalytics {
  const out: ApiKeyAnalytics = {
    basis: "current_state",
    total: 0,
    active: 0,
    disabled: 0,
    revoked: 0,
    expired: 0,
    withAnalyticsScope: 0,
    lastUsedAt: null,
  };
  let lastUsedMs = -1;
  for (const value of values(store.apiKeys?.keys)) {
    if (!isObject(value) || !sameAddress(value.merchant, merchant)) continue;
    out.total += 1;
    const expiresMs = value.expiresAt == null ? null : parseIsoMs(value.expiresAt);
    const isExpired = value.expiresAt != null && (expiresMs == null || nowSeconds * 1000 >= expiresMs);
    if (value.revoked === true) out.revoked += 1;
    else if (isExpired) out.expired += 1;
    else if (value.enabled !== true) out.disabled += 1;
    else out.active += 1;
    if (Array.isArray(value.scopes) && value.scopes.includes("analytics:read")) out.withAnalyticsScope += 1;
    const used = parseIsoMs(value.lastUsedAt);
    if (used != null && used > lastUsedMs) {
      lastUsedMs = used;
      out.lastUsedAt = new Date(used).toISOString();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Escrows (store.escrows.records) filtered by creator. Stored state only; no
// chain lookup, no proof, no transition timeline.
// ---------------------------------------------------------------------------

export type EscrowAnalytics = {
  basis: "createdAt";
  total: number;
  byState: Record<EscrowStateName, AmountBucket>;
  missingCreatedAt: number;
  malformed: number;
};

export function escrowAnalytics(store: StoreFile, merchant: string, range: AnalyticsRange): EscrowAnalytics {
  const buckets = Object.fromEntries(ESCROW_STATES.map((s) => [s, emptyBucket()])) as Record<
    EscrowStateName,
    { count: number; sum: bigint }
  >;
  let total = 0;
  let missingCreatedAt = 0;
  let malformed = 0;
  for (const value of values(store.escrows?.records)) {
    if (!isObject(value) || !sameAddress(value.creator, merchant)) continue;
    const state = value.state;
    const amount = amountOf(value.amountBaseUnits);
    if (!(ESCROW_STATES as readonly unknown[]).includes(state) || amount == null) {
      malformed += 1;
      continue;
    }
    const created = parseIsoMs(value.createdAt);
    if (created == null) {
      missingCreatedAt += 1;
      continue;
    }
    if (!inRange(created, range)) continue;
    total += 1;
    buckets[state as EscrowStateName].count += 1;
    buckets[state as EscrowStateName].sum += amount;
  }
  return {
    basis: "createdAt",
    total,
    byState: Object.fromEntries(ESCROW_STATES.map((s) => [s, bucketOut(buckets[s])])) as Record<EscrowStateName, AmountBucket>,
    missingCreatedAt,
    malformed,
  };
}

// ---------------------------------------------------------------------------
// Overview, policy detail, and time series.
// ---------------------------------------------------------------------------

export type OverviewSections = Partial<{
  payments: PaymentAnalytics;
  agents: AgentAnalytics;
  policies: PolicyAnalytics;
  webhooks: WebhookAnalytics;
  escrows: EscrowAnalytics;
  apiKeys: ApiKeyAnalytics;
}>;

export const OVERVIEW_NOTES = [
  "Read-only. Analytics never reconciles, never marks payments paid, and never reads the chain.",
  "Recorded paid = stored paidTx. A payment that has not been reconciled yet still appears as open.",
  "Normal payment requests have no stored paid time; there is no paid-over-time series for them.",
  "Ranges are half-open UTC [from, to). Ranged sections use the basis field named in each section.",
  "Policies and API keys are current state. Reservation and cap utilization metrics are served by /api/v1/analytics/policies.",
  "Webhook figures cover the last 100 deliveries per endpoint.",
] as const;

export function buildOverview(input: {
  store: StoreFile;
  merchant: string;
  nowSeconds: number;
  range: AnalyticsRange;
  sections: readonly AnalyticsSection[];
}): OverviewSections {
  const { store, merchant, nowSeconds, range } = input;
  const want = new Set(input.sections);
  const out: OverviewSections = {};
  const needRows = want.has("payments") || want.has("agents");
  const rows = needRows ? merchantPaymentRows(store, merchant, nowSeconds) : [];
  const needDenials = want.has("agents") || want.has("policies");
  const denials = needDenials ? merchantDenials(store, merchant) : { denials: [], malformed: 0 };
  if (want.has("payments")) out.payments = paymentAnalytics(rows, range);
  if (want.has("agents")) {
    const { intents, malformed } = merchantIntents(store, merchant, rows, nowSeconds);
    const deniedInRange = denials.denials.filter((d) => inRange(d.evaluatedMs, range)).length;
    out.agents = agentAnalytics(intents, malformed, deniedInRange, range);
  }
  if (want.has("policies")) {
    const { policies, malformed } = merchantPolicies(store, merchant);
    out.policies = policyAnalytics(policies, malformed, denials.denials, denials.malformed, range);
  }
  if (want.has("webhooks")) out.webhooks = webhookAnalytics(store, merchant, range);
  if (want.has("escrows")) out.escrows = escrowAnalytics(store, merchant, range);
  if (want.has("apiKeys")) out.apiKeys = apiKeyAnalytics(store, merchant, nowSeconds);
  return out;
}

export type PolicyDetail = PolicyAnalytics & {
  reservations: ReservationAnalytics;
  utilization: UtilizationRow[];
  spendCapPolicies: number;
};

export function buildPolicyDetail(input: {
  store: StoreFile;
  merchant: string;
  nowSeconds: number;
  range: AnalyticsRange;
  ledger: LedgerDoc | null;
}): PolicyDetail {
  const { policies, malformed } = merchantPolicies(input.store, input.merchant);
  const denials = merchantDenials(input.store, input.merchant);
  const summary = policyAnalytics(policies, malformed, denials.denials, denials.malformed, input.range);
  const verified = verifiedSpendFactsReadOnly(input.store, input.merchant);
  return {
    ...summary,
    spendCapPolicies: summary.withSpendCap,
    reservations: reservationAnalytics(input.ledger, input.merchant, policies),
    utilization: utilizationAnalytics(input.ledger, input.merchant, policies, verified, input.nowSeconds),
  };
}

export type TimeseriesBucket = { start: string; value: number | string };

export type Timeseries = {
  metric: TimeseriesMetric;
  granularity: TimeseriesGranularity;
  basis: "createdAt" | "verifiedAt" | "evaluatedAt";
  unit: "count" | "base_units";
  buckets: TimeseriesBucket[];
  total: number | string;
  excluded: number;
};

export function bucketStart(ms: number, granularity: TimeseriesGranularity): number {
  const step = granularity === "day" ? DAY_MS : HOUR_MS;
  return Math.floor(ms / step) * step;
}

export function buildTimeseries(input: {
  store: StoreFile;
  merchant: string;
  nowSeconds: number;
  range: AnalyticsRange;
  metric: TimeseriesMetric;
  granularity: TimeseriesGranularity;
}): Timeseries {
  const { store, merchant, nowSeconds, range, metric, granularity } = input;
  const step = granularity === "day" ? DAY_MS : HOUR_MS;
  const first = bucketStart(range.fromMs, granularity);
  const counts = new Map<number, bigint>();
  for (let t = first; t < range.toMs; t += step) counts.set(t, 0n);
  let excluded = 0;
  const add = (ms: number, amount: bigint) => {
    if (!inRange(ms, range)) return;
    const key = bucketStart(ms, granularity);
    counts.set(key, (counts.get(key) ?? 0n) + amount);
  };

  let basis: Timeseries["basis"] = "createdAt";
  const volume = metric === "requested_volume" || metric === "agent_verified_volume";
  if (metric === "requests_created" || metric === "requested_volume") {
    for (const row of merchantPaymentRows(store, merchant, nowSeconds)) {
      const created = parseIsoMs(row.createdAt);
      if (created == null) {
        excluded += 1;
        continue;
      }
      add(created, metric === "requests_created" ? 1n : row.amountBaseUnits);
    }
  } else if (metric === "agent_verified" || metric === "agent_verified_volume") {
    basis = "verifiedAt";
    const rows = merchantPaymentRows(store, merchant, nowSeconds);
    for (const intent of merchantIntents(store, merchant, rows, nowSeconds).intents) {
      if (intent.status !== "VERIFIED") continue;
      if (intent.verifiedAt == null) {
        excluded += 1;
        continue;
      }
      if (metric === "agent_verified") add(intent.verifiedAt * 1000, 1n);
      else if (intent.amount == null) excluded += 1;
      else add(intent.verifiedAt * 1000, intent.amount);
    }
  } else {
    basis = "evaluatedAt";
    for (const denial of merchantDenials(store, merchant).denials) add(denial.evaluatedMs, 1n);
  }

  let total = 0n;
  const buckets: TimeseriesBucket[] = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, value]) => {
      total += value;
      return { start: new Date(start).toISOString(), value: volume ? value.toString() : Number(value) };
    });
  return {
    metric,
    granularity,
    basis,
    unit: volume ? "base_units" : "count",
    buckets,
    total: volume ? total.toString() : Number(total),
    excluded,
  };
}
