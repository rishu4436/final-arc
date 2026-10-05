import { formatUnits, getAddress, isAddress, parseUnits, type Address } from "viem";
import { ARC_CHAIN_ID, USDC_DECIMALS } from "./arc";
import { deriveMemoId } from "./finalRequest";
import { formatUsdc } from "./format";
import { decodePayLink, paymentLinkPhase, type PayLinkPhase } from "./payRequest";
import { isTxHash } from "./receipt";

/** Dashboard statuses. VIEWED is not one of them; paymentLinkPhase folds it into OPEN. */
export type DashboardStatus = PayLinkPhase;

export type DashboardRequestRow = {
  token: string;
  version: 1 | 2;
  status: DashboardStatus;
  /** Human USDC string from the decoded request, not a second parser. */
  amount: string;
  amountBaseUnits: bigint;
  memo: string;
  /** V2 request id. V1 has none. */
  requestId: string | null;
  /** V1 link id when the token carries one other than the legacy placeholder. */
  v1LinkId: string | null;
  createdAt: string | null;
  /** Unix seconds. Null on V1. */
  expiresAt: number | null;
  merchant: Address;
  recipient: Address;
  /** deriveMemoId(requestId). Null on V1 or if derivation fails. */
  memoId: string | null;
  /** Backend paidTx when it is a transaction hash. A non-hash paid flag still counts as PAID. */
  paidTx: string | null;
  /** True when the stored row has any paidTx value, including a non-hash. */
  paid: boolean;
  receiptPath: string | null;
  paymentPath: string;
};

export type DashboardTotals = {
  receivedBaseUnits: bigint;
  receivedDisplay: string;
  paid: number;
  pending: number;
  expired: number;
  cancelled: number;
};

export type DashboardModel = {
  locked: boolean;
  rows: DashboardRequestRow[];
  totals: DashboardTotals;
  /** Malformed rows dropped. Other merchants are filtered, not counted here. */
  skipped: number;
};

export type PublicReceiptFacts = {
  memoEventValid: boolean | null;
  settlementValid: boolean | null;
  certificateMatched: boolean | null;
  /** Null when the receipt payload does not say. Never upgraded to true. */
  signaturesCryptographicallyVerified: false | null;
  certificateNote: string | null;
  /** Memo event sender, when the receipt has one. */
  payer: Address | null;
  /** Transaction sender, only when no Memo sender is present. */
  transactionFrom: Address | null;
};

const RECENT_LIMIT = 8;

function zeroTotals(): DashboardTotals {
  return {
    receivedBaseUnits: 0n,
    receivedDisplay: formatUsdc(formatUnits(0n, USDC_DECIMALS)),
    paid: 0,
    pending: 0,
    expired: 0,
    cancelled: 0,
  };
}

export function emptyDashboard(locked = true): DashboardModel {
  return { locked, rows: [], totals: zeroTotals(), skipped: 0 };
}

/**
 * No connected address means no rows, even if records were passed in.
 * That keeps a disconnected view from rendering someone else's payload.
 */
export function dashboardAccess(address: string | null | undefined):
  | { locked: true; merchant: null }
  | { locked: false; merchant: Address } {
  if (typeof address !== "string" || !isAddress(address)) {
    return { locked: true, merchant: null };
  }
  try {
    return { locked: false, merchant: getAddress(address) };
  } catch {
    return { locked: true, merchant: null };
  }
}

export function arcWalletState(chainId: number | undefined): {
  onArc: boolean;
  chainId: number | null;
  networkLabel: string;
} {
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId)) {
    return { onArc: false, chainId: null, networkLabel: "Unknown" };
  }
  if (chainId === ARC_CHAIN_ID) {
    return { onArc: true, chainId, networkLabel: "Arc" };
  }
  return { onArc: false, chainId, networkLabel: "Not Arc" };
}

function sameAddress(left: string, right: string): boolean {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function readStored(value: unknown): {
  token: string;
  paidTx: string | null;
  cancelled: boolean;
  createdAt: string | null;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.token !== "string" || row.token.length === 0) return null;
  const paidRaw = typeof row.paidTx === "string" ? row.paidTx.trim() : "";
  return {
    token: row.token,
    paidTx: paidRaw.length > 0 ? paidRaw : null,
    cancelled: row.cancelled === true,
    createdAt: typeof row.createdAt === "string" && row.createdAt ? row.createdAt : null,
  };
}

function createdMillis(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function baseUnitsFromDecimal(amount: string): bigint | null {
  try {
    return parseUnits(amount, USDC_DECIMALS);
  } catch {
    return null;
  }
}

/**
 * One merchant's rows from stored pay records.
 * Status is paymentLinkPhase: PAID, then CANCELLED, then EXPIRED when now >= expiresAt, else OPEN.
 * Invalid tokens are skipped. Records for other merchants are omitted.
 */
export function buildMerchantDashboard(input: {
  merchant: string | null | undefined;
  records: unknown;
  nowSeconds: number;
}): DashboardModel {
  const access = dashboardAccess(input.merchant);
  if (access.locked) return emptyDashboard(true);

  const nowSeconds = Number.isSafeInteger(input.nowSeconds) ? input.nowSeconds : 0;
  const list = Array.isArray(input.records) ? input.records : [];
  const skippedBase = Array.isArray(input.records) || input.records == null ? 0 : 1;
  const byToken = new Map<string, DashboardRequestRow>();
  let skipped = skippedBase;

  for (const item of list) {
    const stored = readStored(item);
    if (!stored) {
      skipped += 1;
      continue;
    }
    let link: ReturnType<typeof decodePayLink>;
    try {
      link = decodePayLink(stored.token);
    } catch {
      skipped += 1;
      continue;
    }
    if (!link) {
      skipped += 1;
      continue;
    }

    if (link.version === 1) {
      if (!sameAddress(link.request.to, access.merchant)) continue;
      const amountBaseUnits = baseUnitsFromDecimal(link.request.amount);
      if (amountBaseUnits == null) {
        skipped += 1;
        continue;
      }
      const paidTx = stored.paidTx && isTxHash(stored.paidTx) ? stored.paidTx : null;
      byToken.set(stored.token, {
        token: stored.token,
        version: 1,
        status: paymentLinkPhase({
          paid: stored.paidTx != null,
          cancelled: stored.cancelled,
          expiresAt: null,
          nowSeconds,
        }),
        amount: link.request.amount,
        amountBaseUnits,
        memo: link.request.memo,
        requestId: null,
        v1LinkId: link.request.id && link.request.id !== "legacy" ? link.request.id : null,
        createdAt: stored.createdAt,
        expiresAt: null,
        merchant: access.merchant,
        recipient: link.request.to,
        memoId: null,
        paidTx,
        paid: stored.paidTx != null,
        receiptPath: paidTx ? `/r/${paidTx}` : null,
        paymentPath: `/p/${stored.token}`,
      });
      continue;
    }

    if (!sameAddress(link.request.merchant, access.merchant)) continue;
    let memoId: string | null = null;
    try {
      memoId = deriveMemoId(link.request.requestId);
    } catch {
      memoId = null;
    }
    const paidTx = stored.paidTx && isTxHash(stored.paidTx) ? stored.paidTx : null;
    byToken.set(stored.token, {
      token: stored.token,
      version: 2,
      status: paymentLinkPhase({
        paid: stored.paidTx != null,
        cancelled: stored.cancelled,
        expiresAt: link.request.expiresAt,
        nowSeconds,
      }),
      amount: formatUnits(link.request.amountBaseUnits, USDC_DECIMALS),
      amountBaseUnits: link.request.amountBaseUnits,
      memo: link.request.memo,
      requestId: link.request.requestId,
      v1LinkId: null,
      createdAt: stored.createdAt,
      expiresAt: link.request.expiresAt,
      merchant: link.request.merchant,
      recipient: link.request.recipient,
      memoId,
      paidTx,
      paid: stored.paidTx != null,
      receiptPath: paidTx ? `/r/${paidTx}` : null,
      paymentPath: `/p/${stored.token}`,
    });
  }

  const rows = [...byToken.values()].sort((a, b) => createdMillis(b.createdAt) - createdMillis(a.createdAt));
  const totals = zeroTotals();
  for (const row of rows) {
    if (row.status === "PAID") {
      totals.paid += 1;
      totals.receivedBaseUnits += row.amountBaseUnits;
    } else if (row.status === "OPEN") {
      totals.pending += 1;
    } else if (row.status === "EXPIRED") {
      totals.expired += 1;
    } else if (row.status === "CANCELLED") {
      totals.cancelled += 1;
    }
  }
  totals.receivedDisplay = formatUsdc(formatUnits(totals.receivedBaseUnits, USDC_DECIMALS));
  return { locked: false, rows, totals, skipped };
}

/** Settled rows only, newest first. Does not infer PAID from anything except row.status. */
export function recentPayments(model: DashboardModel, limit = RECENT_LIMIT): DashboardRequestRow[] {
  if (model.locked) return [];
  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : RECENT_LIMIT;
  return model.rows.filter((row) => row.status === "PAID").slice(0, cap);
}

function asAddress(value: unknown): Address | null {
  if (typeof value !== "string" || !isAddress(value)) return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Facts already present on GET /api/receipt/:hash.
 * Does not decide whether the transaction settles this request.
 * A payload that claims signatures were cryptographically verified is not trusted.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function factsFromProof(proof: Record<string, unknown>): PublicReceiptFacts | null {
  const verification = asRecord(proof.verification);
  const memo = asRecord(proof.memo);
  const certificate = asRecord(proof.certificate);
  const transaction = asRecord(proof.transaction);
  if (!verification || !memo || !certificate) return null;
  const match = certificate.matchesTransaction;
  const verified = certificate.signaturesCryptographicallyVerified;
  const payer = asAddress(memo.sender);
  return {
    memoEventValid: asBool(verification.memoValid),
    settlementValid: asBool(verification.settlementValid),
    certificateMatched: typeof match === "boolean" ? match : null,
    signaturesCryptographicallyVerified: verified === false ? false : null,
    certificateNote: typeof certificate.note === "string" ? certificate.note : null,
    payer,
    transactionFrom: payer ? null : asAddress(transaction?.from),
  };
}

export function receiptFactsFromPayload(payload: unknown): PublicReceiptFacts | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;
  const nested = asRecord(body.proof);
  if (nested) {
    const facts = factsFromProof(nested);
    if (facts) return facts;
  }
  if (asRecord(body.verification)) {
    const facts = factsFromProof(body);
    if (facts) return facts;
  }
  const parsed = body.parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const receipt = parsed as Record<string, unknown>;
  const certRaw = body.certCheck;
  const cert =
    certRaw && typeof certRaw === "object" && !Array.isArray(certRaw)
      ? (certRaw as Record<string, unknown>)
      : null;
  const verified = cert ? asBool(cert.signaturesCryptographicallyVerified) : null;
  return {
    memoEventValid: asBool(receipt.memoEventValid),
    settlementValid: asBool(receipt.settlementValid),
    certificateMatched: cert ? asBool(cert.matched) : null,
    signaturesCryptographicallyVerified: verified === false ? false : null,
    certificateNote: cert && typeof cert.note === "string" ? cert.note : null,
    payer: asAddress(receipt.sender),
    transactionFrom: asAddress(receipt.sender) ? null : asAddress(receipt.from),
  };
}

export type WorkspaceMetrics = {
  total: number;
  open: number;
  paid: number;
  expired: number;
  cancelled: number;
  /** Sum of rows whose paymentLinkPhase is PAID. Not inferred from a hash or a receipt. */
  paidBaseUnits: bigint;
  paidDisplay: string;
  /** Sum of rows whose paymentLinkPhase is OPEN. Expired and cancelled are not included. */
  outstandingBaseUnits: bigint;
  outstandingDisplay: string;
};

/** Counts and USDC volumes from stored phases. Does not reimplement paymentLinkPhase. */
export function workspaceMetrics(model: DashboardModel): WorkspaceMetrics {
  let outstandingBaseUnits = 0n;
  if (!model.locked) {
    for (const row of model.rows) {
      if (row.status === "OPEN") outstandingBaseUnits += row.amountBaseUnits;
    }
  }
  return {
    total: model.locked ? 0 : model.rows.length,
    open: model.totals.pending,
    paid: model.totals.paid,
    expired: model.totals.expired,
    cancelled: model.totals.cancelled,
    paidBaseUnits: model.totals.receivedBaseUnits,
    paidDisplay: model.totals.receivedDisplay,
    outstandingBaseUnits,
    outstandingDisplay: formatUsdc(formatUnits(outstandingBaseUnits, USDC_DECIMALS)),
  };
}

export type RequestStatusFilter = "ALL" | DashboardStatus;
export type RequestSort = "newest" | "oldest" | "amount-asc" | "amount-desc";

function compareAmount(left: DashboardRequestRow, right: DashboardRequestRow): number {
  if (left.amountBaseUnits === right.amountBaseUnits) return 0;
  return left.amountBaseUnits < right.amountBaseUnits ? -1 : 1;
}

/**
 * Client filter over rows already scoped to one merchant.
 * Search covers token, V2 request id, memo, transaction hash, merchant, and recipient.
 * It does not search a payer, because payer is not stored on the row.
 */
export function filterMerchantRequests(
  rows: DashboardRequestRow[],
  input: { search?: string; status?: RequestStatusFilter; sort?: RequestSort },
): DashboardRequestRow[] {
  const query = (input.search ?? "").trim().toLowerCase();
  const status = input.status ?? "ALL";
  const filtered = rows.filter((row) => {
    if (status !== "ALL" && row.status !== status) return false;
    if (!query) return true;
    const fields = [row.token, row.requestId ?? "", row.memo, row.paidTx ?? "", row.merchant, row.recipient];
    return fields.some((field) => field.toLowerCase().includes(query));
  });
  const sort = input.sort ?? "newest";
  return [...filtered].sort((left, right) => {
    if (sort === "oldest") return createdMillis(left.createdAt) - createdMillis(right.createdAt);
    if (sort === "amount-asc") return compareAmount(left, right);
    if (sort === "amount-desc") return compareAmount(right, left);
    return createdMillis(right.createdAt) - createdMillis(left.createdAt);
  });
}

export type ActivityKind = "created" | "cancelled" | "expired" | "paid" | "transaction" | "receipt";

export type ActivityEntry = {
  key: string;
  token: string;
  kind: ActivityKind;
  title: string;
  /** Set only when a real stored or request timestamp exists for this fact. Never a paid time. */
  at: string | null;
  /** What `at` means. Null when there is no timestamp. */
  timeLabel: "Created" | "Expiry" | null;
  note: string;
  /** Hash or path when the entry is availability, not a time. */
  detail: string | null;
  amount: string;
  memo: string;
  status: DashboardStatus;
};

const ACTIVITY_RANK: Record<ActivityKind, number> = {
  created: 0,
  cancelled: 1,
  expired: 1,
  paid: 1,
  transaction: 2,
  receipt: 3,
};

function expiryIso(seconds: number | null): string | null {
  if (seconds == null || !Number.isSafeInteger(seconds)) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Operational feed from stored rows. Does not invent paidAt or a cancellation time. */
export function buildActivity(model: DashboardModel): ActivityEntry[] {
  if (model.locked) return [];
  const stamped: { entry: ActivityEntry; created: number }[] = [];
  for (const row of model.rows) {
    const base = { token: row.token, amount: row.amount, memo: row.memo, status: row.status };
    const created = createdMillis(row.createdAt);
    const push = (entry: ActivityEntry) => stamped.push({ entry, created });
    push({
      ...base,
      key: `${row.token}:created`,
      kind: "created",
      title: "Payment request created",
      at: row.createdAt,
      timeLabel: row.createdAt ? "Created" : null,
      note: row.createdAt ? "Stored created time." : "Created time is not stored.",
      detail: null,
    });
    if (row.status === "CANCELLED") {
      push({
        ...base,
        key: `${row.token}:cancelled`,
        kind: "cancelled",
        title: "Payment request cancelled",
        at: null,
        timeLabel: null,
        note: "Cancellation time is not stored.",
        detail: null,
      });
    } else if (row.status === "EXPIRED") {
      const at = expiryIso(row.expiresAt);
      push({
        ...base,
        key: `${row.token}:expired`,
        kind: "expired",
        title: "Payment request expired",
        at,
        timeLabel: at ? "Expiry" : null,
        note: at ? "This is the request expiry, not a recorded event time." : "Expiry time is not stored.",
        detail: null,
      });
    } else if (row.status === "PAID") {
      push({
        ...base,
        key: `${row.token}:paid`,
        kind: "paid",
        title: "Payment recorded as paid",
        at: null,
        timeLabel: null,
        note: "Paid time is not stored. Created time is not the paid time.",
        detail: null,
      });
    }
    if (row.paidTx) {
      push({
        ...base,
        key: `${row.token}:transaction`,
        kind: "transaction",
        title: "Transaction hash recorded",
        at: null,
        timeLabel: null,
        note: "Availability only. No transaction time is stored.",
        detail: row.paidTx,
      });
    }
    if (row.receiptPath) {
      push({
        ...base,
        key: `${row.token}:receipt`,
        kind: "receipt",
        title: "Receipt link available",
        at: null,
        timeLabel: null,
        note: "Availability only. No receipt time is stored.",
        detail: row.receiptPath,
      });
    }
  }
  stamped.sort((left, right) => {
    if (left.created !== right.created) return right.created - left.created;
    return ACTIVITY_RANK[left.entry.kind] - ACTIVITY_RANK[right.entry.kind];
  });
  return stamped.map((item) => item.entry);
}

export type CreatedDayBucket = { date: string; count: number };

export type WorkspaceAnalytics = WorkspaceMetrics & {
  /** UTC dates of createdAt. This is not paid time. */
  createdByDay: CreatedDayBucket[];
  missingCreatedAt: number;
};

function createdDay(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

/** Same stored counts as the overview, plus a created-date grouping when createdAt exists. */
export function buildAnalytics(model: DashboardModel): WorkspaceAnalytics {
  const metrics = workspaceMetrics(model);
  if (model.locked) return { ...metrics, createdByDay: [], missingCreatedAt: 0 };
  const counts = new Map<string, number>();
  let missingCreatedAt = 0;
  for (const row of model.rows) {
    const day = createdDay(row.createdAt);
    if (!day) {
      missingCreatedAt += 1;
      continue;
    }
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const createdByDay = [...counts.entries()]
    .sort((left, right) => (left[0] < right[0] ? 1 : left[0] > right[0] ? -1 : 0))
    .map(([date, count]) => ({ date, count }));
  return { ...metrics, createdByDay, missingCreatedAt };
}

const CSV_COLUMNS = [
  "token",
  "version",
  "requestId",
  "memoId",
  "merchant",
  "recipient",
  "amountBaseUnits",
  "formattedAmount",
  "memo",
  "createdAt",
  "expiresAt",
  "status",
  "paidTx",
] as const;

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** CSV for the rows passed in. V1 leaves request id, memo id, and expiry blank. */
export function requestsToCsv(rows: DashboardRequestRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    const cells = [
      row.token,
      String(row.version),
      row.requestId ?? "",
      row.memoId ?? "",
      row.merchant,
      row.recipient,
      row.amountBaseUnits.toString(),
      formatUsdc(row.amount),
      row.memo,
      row.createdAt ?? "",
      row.expiresAt == null ? "" : String(row.expiresAt),
      row.status,
      row.paidTx ?? "",
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Locked models export a header only, so a disconnected view cannot emit rows. */
export function exportWorkspaceCsv(model: DashboardModel): string {
  if (model.locked) return requestsToCsv([]);
  return requestsToCsv(model.rows);
}

export type ShareTarget = "payment" | "receipt" | "requestId" | "transaction";

/** Which copy targets exist. Does not mint a token or a URL. */
export function shareTargets(row: DashboardRequestRow): ShareTarget[] {
  const targets: ShareTarget[] = [];
  if (row.status === "OPEN") targets.push("payment");
  if (row.status === "PAID" && row.receiptPath) targets.push("receipt");
  if (row.requestId) targets.push("requestId");
  if (row.paidTx) targets.push("transaction");
  return targets;
}

export type RequestLookup =
  | { state: "invalid" }
  | { state: "missing" }
  | { state: "found"; row: DashboardRequestRow };

/** Invalid when the token is not a payment link. Missing when it is not this merchant's row. */
export function lookupWorkspaceRequest(model: DashboardModel, token: string): RequestLookup {
  if (typeof token !== "string" || token.trim() === "") return { state: "invalid" };
  let link: ReturnType<typeof decodePayLink>;
  try {
    link = decodePayLink(token);
  } catch {
    return { state: "invalid" };
  }
  if (!link) return { state: "invalid" };
  const row = model.rows.find((item) => item.token === token);
  if (!row) return { state: "missing" };
  return { state: "found", row };
}

const WORKSPACE_LOAD_ERROR = "Payment requests could not be loaded.";

/**
 * Pass through a short public message. Replace paths, stacks, and storage details.
 * Does not decide payment status.
 */
export function presentWorkspaceError(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  if (text.length > 160 || /[\r\n]/.test(text)) return WORKSPACE_LOAD_ERROR;
  if (/[/\\]|\bat\s+\S+\s*\(|stack|redis|upstash|KV_|secret|token=|process\.env/i.test(text)) {
    return WORKSPACE_LOAD_ERROR;
  }
  return text;
}
