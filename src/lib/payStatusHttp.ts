import { getAddress, isAddress, type Address } from "viem";
import { loadMemoLedger, type LedgerEntry } from "./ledger";
import { notifyWebhook } from "./notify";
import { findSettlementProof, lookupFromRecord, payRecordIdentity, type PaidLookup, type PayIdentity } from "./payPaid";
import {
  getRecord,
  listByPayee,
  markCancelled,
  markPaid,
  markViewed,
  upsertRecord,
  type CancelCommand,
  type PaidProof,
  type PayRecord,
} from "./payStore";
import { PAYMENT_STATUS_UNAVAILABLE, reconcilePaymentRecord } from "./reconcilePayment";
import { resolveCancellation } from "./resolveCancellation";

export type PayHttpResult = {
  status: number;
  body: { record: PayRecord } | { records: PayRecord[] } | { error: string };
};

export type StatementHttpResult = {
  status: number;
  body: { payments: LedgerEntry[]; links: PayRecord[] } | { error: string };
};

export type PayStatusDeps = {
  getRecord: (token: string) => Promise<PayRecord | null>;
  listByPayee: (to: Address) => Promise<PayRecord[]>;
  markCancelled: (token: string, command: CancelCommand) => Promise<PayRecord | null>;
  markPaid: (token: string, proof: PaidProof) => Promise<PayRecord | null>;
  markViewed: (token: string) => Promise<PayRecord | null>;
  upsertRecord: (record: PayRecord) => Promise<PayRecord>;
  findSettlementProof: (lookup: PaidLookup) => Promise<PaidProof | null>;
  notifyWebhook: (record: PayRecord, event: "viewed" | "paid" | "cancelled") => Promise<void>;
  loadMemoLedger: (account: Address) => Promise<LedgerEntry[]>;
};

type PostBody = {
  token?: string;
  action?: "register" | "view" | "cancel";
  address?: string;
  signature?: string;
  webhookUrl?: string;
};

function unavailable(): PayHttpResult {
  return { status: 503, body: { error: PAYMENT_STATUS_UNAVAILABLE } };
}

function statementUnavailable(): StatementHttpResult {
  return { status: 503, body: { error: PAYMENT_STATUS_UNAVAILABLE } };
}

function blankRecord(token: string, identity: PayIdentity, webhookUrl: string | null): PayRecord {
  return {
    token,
    id: identity.id,
    to: identity.to,
    amount: identity.amount,
    memo: identity.memo,
    createdAt: new Date().toISOString(),
    views: 0,
    lastViewedAt: null,
    cancelled: false,
    cancelledAt: null,
    paidTx: null,
    webhookUrl,
  };
}

function tokenFrom(body: PostBody | null): string | null {
  const token = body?.token?.trim();
  return token || null;
}

async function withPaid(row: PayRecord, deps: PayStatusDeps): Promise<PayRecord> {
  return reconcilePaymentRecord(row, {
    findSettlementProof: deps.findSettlementProof,
    markPaid: deps.markPaid,
    notifyPaid: (updated) => {
      void deps.notifyWebhook(updated, "paid");
    },
  });
}

async function payGetInner(request: Request, deps: PayStatusDeps): Promise<PayHttpResult> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const to = url.searchParams.get("to");

  if (token) {
    let row = await deps.getRecord(token);
    if (!row) {
      const identity = payRecordIdentity(token);
      if (!identity) return { status: 404, body: { error: "Unknown payment." } };
      row = await deps.upsertRecord(blankRecord(token, identity, null));
    }
    row = await withPaid(row, deps);
    return { status: 200, body: { record: row } };
  }

  if (to && isAddress(to)) {
    const rows = await deps.listByPayee(getAddress(to));
    const records = await Promise.all(rows.map((row) => withPaid(row, deps)));
    return { status: 200, body: { records } };
  }

  return { status: 400, body: { error: "token or to required" } };
}

async function payPostInner(body: PostBody, deps: PayStatusDeps): Promise<PayHttpResult> {
  const token = tokenFrom(body);
  if (!token) return { status: 400, body: { error: "token required" } };
  const identity = payRecordIdentity(token);
  if (!identity) return { status: 400, body: { error: "Invalid payment link." } };

  const action = body.action ?? "register";

  if (action === "register") {
    const webhookUrl =
      typeof body.webhookUrl === "string" && /^https:\/\//i.test(body.webhookUrl) ? body.webhookUrl : null;
    const row = await deps.upsertRecord(blankRecord(token, identity, webhookUrl));
    return { status: 200, body: { record: await withPaid(row, deps) } };
  }

  if (action === "view") {
    let row = await deps.getRecord(token);
    if (!row) {
      row = await deps.upsertRecord(blankRecord(token, identity, null));
    }
    row = (await deps.markViewed(token)) ?? row;
    const next = await withPaid(row, deps);
    if (!next.paidTx) void deps.notifyWebhook(next, "viewed");
    return { status: 200, body: { record: next } };
  }

  if (action === "cancel") {
    const lookup = lookupFromRecord({
      token,
      to: identity.to,
      amount: identity.amount,
      memo: identity.memo,
      cancelled: false,
    });
    const resolved = await resolveCancellation(
      {
        token,
        identity,
        lookup,
        address: body.address,
        signature: body.signature,
        nowSeconds: Math.floor(Date.now() / 1000),
      },
      {
        getRecord: deps.getRecord,
        markPaid: deps.markPaid,
        markCancelled: deps.markCancelled,
        findSettlementProof: deps.findSettlementProof,
        ensureRecord: () => deps.upsertRecord(blankRecord(token, identity, null)),
      },
    );
    if (!resolved.ok) {
      return { status: resolved.status, body: { error: resolved.error } };
    }
    if (resolved.notify) void deps.notifyWebhook(resolved.record, resolved.notify);
    return { status: 200, body: { record: resolved.record } };
  }

  return { status: 400, body: { error: "Unknown action" } };
}

/** GET /api/pay. Infrastructure failures are 503, not an unpaid record. */
export async function payGet(request: Request, deps: PayStatusDeps): Promise<PayHttpResult> {
  try {
    return await payGetInner(request, deps);
  } catch {
    return unavailable();
  }
}

/** POST /api/pay. A thrown settlement or store call does not store a cancel and is not unpaid. */
export async function payPost(request: Request, deps: PayStatusDeps): Promise<PayHttpResult> {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return { status: 400, body: { error: "token required" } };
  }
  try {
    return await payPostInner(body, deps);
  } catch {
    return unavailable();
  }
}

/** GET /api/statement. A ledger or settlement failure is 503, not a finished unpaid list. */
export async function statementGet(request: Request, deps: PayStatusDeps): Promise<StatementHttpResult> {
  const url = new URL(request.url);
  const address = url.searchParams.get("address");
  if (!address || !isAddress(address)) {
    return { status: 400, body: { error: "Valid address required." } };
  }
  const account = getAddress(address);
  try {
    const payments = await deps.loadMemoLedger(account);
    const links = await deps.listByPayee(account);
    const openLinks: PayRecord[] = [];
    for (const row of links) {
      openLinks.push(await withPaid(row, deps));
    }
    return { status: 200, body: { payments, links: openLinks } };
  } catch {
    return statementUnavailable();
  }
}

export const livePayStatusDeps: PayStatusDeps = {
  getRecord,
  listByPayee,
  markCancelled,
  markPaid,
  markViewed,
  upsertRecord,
  findSettlementProof,
  notifyWebhook,
  loadMemoLedger,
};
