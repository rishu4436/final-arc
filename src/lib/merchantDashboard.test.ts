import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex } from "viem";
import { ARC_CHAIN_ID } from "./arc";
import { deriveMemoId, type FinalRequest } from "./finalRequest";
import {
  arcWalletState,
  buildMerchantDashboard,
  dashboardAccess,
  emptyDashboard,
  receiptFactsFromPayload,
  recentPayments,
} from "./merchantDashboard";
import { encodePayRequest, encodeV2PayRequest } from "./payRequest";

const MERCHANT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const REQUEST_ID = ("0x" + "ab".repeat(16)) as Hex;
const NONCE = ("0x" + "cd".repeat(32)) as Hex;
const TX = ("0x" + "11".repeat(32)) as Hex;
const NOW = 1_800_000_000;

function v2(overrides: Partial<FinalRequest> = {}): FinalRequest {
  return {
    version: 2,
    requestId: REQUEST_ID,
    merchant: MERCHANT,
    recipient: MERCHANT,
    amountBaseUnits: 1_500_000n,
    memo: "INV-1",
    chainId: ARC_CHAIN_ID,
    expiresAt: NOW + 86_400,
    nonce: NONCE,
    signature: ("0x" + "22".repeat(65)) as Hex,
    ...overrides,
  };
}

function stored(token: string, overrides: Record<string, unknown> = {}) {
  return {
    token,
    createdAt: "2026-10-04T00:00:00.000Z",
    cancelled: false,
    paidTx: null,
    ...overrides,
  };
}

test("no address locks the model and drops every record", () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "1", memo: "rent" });
  const model = buildMerchantDashboard({
    merchant: null,
    records: [stored(token)],
    nowSeconds: NOW,
  });
  assert.deepEqual(model, emptyDashboard(true));
  assert.equal(dashboardAccess(undefined).locked, true);
  assert.equal(dashboardAccess("not-an-address").locked, true);
  assert.equal(recentPayments(model).length, 0);
});

test("empty records are zero totals", () => {
  const model = buildMerchantDashboard({ merchant: MERCHANT, records: [], nowSeconds: NOW });
  assert.equal(model.locked, false);
  assert.equal(model.rows.length, 0);
  assert.equal(model.skipped, 0);
  assert.equal(model.totals.paid, 0);
  assert.equal(model.totals.pending, 0);
  assert.equal(model.totals.expired, 0);
  assert.equal(model.totals.cancelled, 0);
  assert.equal(model.totals.receivedBaseUnits, 0n);
  assert.equal(model.totals.receivedDisplay, "0.00");
});

test("filters to the merchant and ignores address case", () => {
  const mine = encodePayRequest({ to: MERCHANT, amount: "0.20", memo: "mine" });
  const theirs = encodePayRequest({ to: OTHER, amount: "9", memo: "theirs" });
  const model = buildMerchantDashboard({
    merchant: MERCHANT.toLowerCase(),
    records: [stored(theirs, { createdAt: "2026-10-03T00:00:00.000Z" }), stored(mine)],
    nowSeconds: NOW,
  });
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].token, mine);
  assert.equal(model.rows[0].memo, "mine");
  assert.equal(model.rows[0].merchant, MERCHANT);
  assert.equal(model.skipped, 0);
});

test("status uses paymentLinkPhase, including paid over expiry and cancel over expiry", () => {
  const open = encodeV2PayRequest(v2({ requestId: ("0x" + "01".repeat(16)) as Hex }));
  const paid = encodeV2PayRequest(v2({ requestId: ("0x" + "02".repeat(16)) as Hex, expiresAt: NOW - 10 }));
  const expired = encodeV2PayRequest(v2({ requestId: ("0x" + "03".repeat(16)) as Hex, expiresAt: NOW }));
  const cancelled = encodeV2PayRequest(
    v2({ requestId: ("0x" + "04".repeat(16)) as Hex, expiresAt: NOW - 10 }),
  );
  const model = buildMerchantDashboard({
    merchant: MERCHANT,
    records: [
      stored(open, { createdAt: "2026-10-01T00:00:00.000Z" }),
      stored(paid, { createdAt: "2026-10-02T00:00:00.000Z", paidTx: TX }),
      stored(expired, { createdAt: "2026-10-03T00:00:00.000Z" }),
      stored(cancelled, { createdAt: "2026-10-04T00:00:00.000Z", cancelled: true }),
    ],
    nowSeconds: NOW,
  });
  const byMemo = Object.fromEntries(model.rows.map((row) => [row.requestId, row.status]));
  const openId = model.rows.find((row) => row.token === open)?.requestId;
  const paidId = model.rows.find((row) => row.token === paid)?.requestId;
  const expiredId = model.rows.find((row) => row.token === expired)?.requestId;
  const cancelledId = model.rows.find((row) => row.token === cancelled)?.requestId;
  assert.equal(byMemo[openId!], "OPEN");
  assert.equal(byMemo[paidId!], "PAID");
  assert.equal(byMemo[expiredId!], "EXPIRED");
  assert.equal(byMemo[cancelledId!], "CANCELLED");
  assert.equal(model.totals.pending, 1);
  assert.equal(model.totals.paid, 1);
  assert.equal(model.totals.expired, 1);
  assert.equal(model.totals.cancelled, 1);
});

test("V1 has no request id, expiry, or memo id", () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "0.2", memo: "rent" });
  const model = buildMerchantDashboard({
    merchant: MERCHANT,
    records: [stored(token, { paidTx: TX })],
    nowSeconds: NOW,
  });
  const row = model.rows[0];
  assert.equal(row.version, 1);
  assert.equal(row.requestId, null);
  assert.equal(row.expiresAt, null);
  assert.equal(row.memoId, null);
  assert.equal(row.status, "PAID");
  assert.ok(row.v1LinkId);
  assert.notEqual(row.v1LinkId, "legacy");
  assert.equal(row.memo, "rent");
  assert.equal(row.recipient, MERCHANT);
  assert.equal(row.paidTx, TX);
  assert.equal(row.receiptPath, `/r/${TX}`);
});

test("V2 display uses the signed request and deriveMemoId", () => {
  const request = v2();
  const token = encodeV2PayRequest(request);
  const model = buildMerchantDashboard({
    merchant: MERCHANT,
    records: [stored(token)],
    nowSeconds: NOW,
  });
  const row = model.rows[0];
  assert.equal(row.version, 2);
  assert.equal(row.status, "OPEN");
  assert.equal(row.requestId, REQUEST_ID);
  assert.equal(row.expiresAt, request.expiresAt);
  assert.equal(row.memoId, deriveMemoId(REQUEST_ID));
  assert.equal(row.memo, "INV-1");
  assert.equal(row.amount, "1.5");
  assert.equal(row.amountBaseUnits, 1_500_000n);
  assert.equal(row.merchant, MERCHANT);
  assert.equal(row.recipient, MERCHANT);
  assert.equal(row.v1LinkId, null);
  assert.equal(row.paidTx, null);
  assert.equal(row.receiptPath, null);
  assert.equal(row.paymentPath, `/p/${token}`);
});

test("missing transaction hash does not invent a receipt", () => {
  const token = encodeV2PayRequest(v2());
  const model = buildMerchantDashboard({
    merchant: MERCHANT,
    records: [stored(token, { paidTx: "not-a-hash" })],
    nowSeconds: NOW,
  });
  const row = model.rows[0];
  assert.equal(row.status, "PAID");
  assert.equal(row.paid, true);
  assert.equal(row.paidTx, null);
  assert.equal(row.receiptPath, null);
});

test("received total sums only PAID base units", () => {
  const paidA = encodeV2PayRequest(v2({ requestId: ("0x" + "a1".repeat(16)) as Hex, amountBaseUnits: 1_500_000n }));
  const paidB = encodePayRequest({ to: MERCHANT, amount: "0.50", memo: "second" });
  const open = encodeV2PayRequest(v2({ requestId: ("0x" + "a2".repeat(16)) as Hex, amountBaseUnits: 9_000_000n }));
  const model = buildMerchantDashboard({
    merchant: MERCHANT,
    records: [
      stored(paidA, { paidTx: TX, createdAt: "2026-10-02T00:00:00.000Z" }),
      stored(paidB, { paidTx: ("0x" + "33".repeat(32)) as string, createdAt: "2026-10-04T00:00:00.000Z" }),
      stored(open, { createdAt: "2026-10-03T00:00:00.000Z" }),
    ],
    nowSeconds: NOW,
  });
  assert.equal(model.totals.receivedBaseUnits, 2_000_000n);
  assert.equal(model.totals.receivedDisplay, "2.00");
  assert.equal(model.totals.paid, 2);
  assert.equal(model.totals.pending, 1);
  const recent = recentPayments(model);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].token, paidB);
  assert.ok(recent.every((row) => row.status === "PAID"));
});

test("invalid records are skipped and do not throw", () => {
  const good = encodePayRequest({ to: MERCHANT, amount: "1", memo: "ok" });
  const model = buildMerchantDashboard({
    merchant: MERCHANT,
    records: [null, 4, { token: "" }, { token: "%%%" }, { amount: "1" }, stored(good)],
    nowSeconds: NOW,
  });
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].memo, "ok");
  assert.equal(model.skipped, 5);
  assert.equal(model.totals.pending, 1);
  assert.doesNotThrow(() =>
    buildMerchantDashboard({ merchant: MERCHANT, records: { nope: true }, nowSeconds: Number.NaN }),
  );
  const bad = buildMerchantDashboard({ merchant: MERCHANT, records: { nope: true }, nowSeconds: Number.NaN });
  assert.equal(bad.rows.length, 0);
  assert.equal(bad.skipped, 1);
  assert.equal(bad.totals.receivedBaseUnits, 0n);
});

test("arc wallet state names Arc only on chain 5042", () => {
  assert.deepEqual(arcWalletState(ARC_CHAIN_ID), { onArc: true, chainId: 5042, networkLabel: "Arc" });
  assert.equal(arcWalletState(8453).onArc, false);
  assert.equal(arcWalletState(8453).networkLabel, "Not Arc");
  assert.equal(arcWalletState(8453).chainId, 8453);
  assert.equal(arcWalletState(undefined).onArc, false);
  assert.equal(arcWalletState(undefined).chainId, null);
});

test("receipt facts copy booleans and do not treat a true signature flag as verified", () => {
  const facts = receiptFactsFromPayload({
    parsed: {
      memoEventValid: true,
      settlementValid: false,
      sender: OTHER.toLowerCase(),
      from: MERCHANT,
    },
    certCheck: {
      matched: true,
      signaturesCryptographicallyVerified: false,
      note: "Height and block hash match. Not verified.",
    },
  });
  assert.equal(facts?.memoEventValid, true);
  assert.equal(facts?.settlementValid, false);
  assert.equal(facts?.certificateMatched, true);
  assert.equal(facts?.signaturesCryptographicallyVerified, false);
  assert.equal(facts?.payer, OTHER);
  assert.equal(facts?.transactionFrom, null);
  assert.match(facts?.certificateNote ?? "", /Not verified/);

  const forged = receiptFactsFromPayload({
    parsed: { memoEventValid: true, from: MERCHANT },
    certCheck: { matched: false, signaturesCryptographicallyVerified: true, note: 12 },
  });
  assert.equal(forged?.signaturesCryptographicallyVerified, null);
  assert.equal(forged?.certificateNote, null);
  assert.equal(forged?.payer, null);
  assert.equal(forged?.transactionFrom, MERCHANT);
  assert.equal(receiptFactsFromPayload({ error: "nope" }), null);
  assert.equal(receiptFactsFromPayload(null), null);

  const partial = receiptFactsFromPayload({
    status: "PARTIAL",
    verification: { memoValid: true, settlementValid: true },
    memo: { sender: OTHER },
    transaction: { from: MERCHANT },
    certificate: {
      matchesTransaction: null,
      signaturesCryptographicallyVerified: false,
      note: "Certificate unavailable from RPC.",
    },
  });
  assert.equal(partial?.certificateMatched, null);
  assert.equal(partial?.settlementValid, true);
  assert.equal(partial?.signaturesCryptographicallyVerified, false);
  assert.equal(partial?.payer, OTHER);
});

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  buildActivity,
  buildAnalytics,
  exportWorkspaceCsv,
  filterMerchantRequests,
  lookupWorkspaceRequest,
  presentWorkspaceError,
  shareTargets,
  workspaceMetrics,
} from "./merchantDashboard";

function rowsFor(records: unknown[]) {
  return buildMerchantDashboard({ merchant: MERCHANT, records, nowSeconds: NOW }).rows;
}

test("search matches token, V2 request id, memo, and transaction hash, not an absent payer", () => {
  const request = v2();
  const token = encodeV2PayRequest(request);
  const rows = rowsFor([stored(token, { paidTx: TX })]);
  assert.equal(filterMerchantRequests(rows, { search: token.slice(0, 12) }).length, 1);
  assert.equal(filterMerchantRequests(rows, { search: REQUEST_ID.slice(2, 10) }).length, 1);
  assert.equal(filterMerchantRequests(rows, { search: "inv-1" }).length, 1);
  assert.equal(filterMerchantRequests(rows, { search: TX.slice(0, 12) }).length, 1);
  assert.equal(filterMerchantRequests(rows, { search: MERCHANT.slice(0, 8) }).length, 1);
  assert.equal(filterMerchantRequests(rows, { search: "0xpayerdoesnotexist" }).length, 0);
});

test("status filter and createdAt or amount sorting do not invent dates", () => {
  const open = encodeV2PayRequest(v2({ requestId: ("0x" + "11".repeat(16)) as Hex, amountBaseUnits: 3_000_000n }));
  const paid = encodeV2PayRequest(v2({ requestId: ("0x" + "22".repeat(16)) as Hex, amountBaseUnits: 1_000_000n }));
  const rows = rowsFor([
    stored(open, { createdAt: "2026-10-01T00:00:00.000Z" }),
    stored(paid, { createdAt: "2026-10-04T00:00:00.000Z", paidTx: TX }),
  ]);
  assert.equal(filterMerchantRequests(rows, { status: "OPEN" }).length, 1);
  assert.equal(filterMerchantRequests(rows, { status: "PAID" })[0].status, "PAID");
  assert.equal(filterMerchantRequests(rows, { status: "ALL" }).length, 2);
  const newest = filterMerchantRequests(rows, { sort: "newest" });
  const oldest = filterMerchantRequests(rows, { sort: "oldest" });
  assert.equal(newest[0].token, paid);
  assert.equal(oldest[0].token, open);
  const low = filterMerchantRequests(rows, { sort: "amount-asc" });
  const high = filterMerchantRequests(rows, { sort: "amount-desc" });
  assert.equal(low[0].amountBaseUnits, 1_000_000n);
  assert.equal(high[0].amountBaseUnits, 3_000_000n);
  assert.equal(low[0].createdAt, "2026-10-04T00:00:00.000Z");
});

test("outstanding is OPEN only and paid-over-expiry stays PAID", () => {
  const open = encodeV2PayRequest(v2({ requestId: ("0x" + "31".repeat(16)) as Hex, amountBaseUnits: 4_000_000n }));
  const paidLate = encodeV2PayRequest(
    v2({ requestId: ("0x" + "32".repeat(16)) as Hex, amountBaseUnits: 2_000_000n, expiresAt: NOW - 50 }),
  );
  const expired = encodeV2PayRequest(
    v2({ requestId: ("0x" + "33".repeat(16)) as Hex, amountBaseUnits: 9_000_000n, expiresAt: NOW }),
  );
  const cancelled = encodeV2PayRequest(
    v2({ requestId: ("0x" + "34".repeat(16)) as Hex, amountBaseUnits: 8_000_000n }),
  );
  const model = buildMerchantDashboard({
    merchant: MERCHANT,
    records: [
      stored(open),
      stored(paidLate, { paidTx: TX }),
      stored(expired),
      stored(cancelled, { cancelled: true }),
    ],
    nowSeconds: NOW,
  });
  const metrics = workspaceMetrics(model);
  assert.equal(model.rows.find((row) => row.token === paidLate)?.status, "PAID");
  assert.equal(metrics.total, 4);
  assert.equal(metrics.open, 1);
  assert.equal(metrics.paid, 1);
  assert.equal(metrics.expired, 1);
  assert.equal(metrics.cancelled, 1);
  assert.equal(metrics.paidBaseUnits, 2_000_000n);
  assert.equal(metrics.paidDisplay, "2.00");
  assert.equal(metrics.outstandingBaseUnits, 4_000_000n);
  assert.equal(metrics.outstandingDisplay, "4.00");
});

test("CSV exports only the scoped merchant and leaves V1 identity fields blank", () => {
  const v1 = encodePayRequest({ to: MERCHANT, amount: "0.2", memo: "rent, \"quoted\"" });
  const v2token = encodeV2PayRequest(v2());
  const theirs = encodePayRequest({ to: OTHER, amount: "9", memo: "theirs-secret" });
  const model = buildMerchantDashboard({
    merchant: MERCHANT,
    records: [stored(v1), stored(v2token, { paidTx: TX }), stored(theirs)],
    nowSeconds: NOW,
  });
  const csv = exportWorkspaceCsv(model);
  assert.equal(csv.startsWith("token,version,requestId,memoId,merchant,recipient,amountBaseUnits,formattedAmount,memo,createdAt,expiresAt,status,paidTx\n"), true);
  assert.equal(csv.includes("theirs-secret"), false);
  assert.equal(csv.includes(OTHER), false);
  const v1Line = csv.split("\n").find((line) => line.startsWith(v1));
  assert.ok(v1Line);
  assert.match(v1Line, /^[^,]+,1,,,/);
  assert.match(v1Line, /,"rent, ""quoted""",/);
  assert.equal(csv.includes(REQUEST_ID), true);
  assert.equal(csv.includes(deriveMemoId(REQUEST_ID)), true);
  assert.equal(exportWorkspaceCsv(emptyDashboard(true)).trim().split("\n").length, 1);
});

test("activity and analytics do not invent paid or cancellation times", () => {
  const open = encodeV2PayRequest(v2({ requestId: ("0x" + "41".repeat(16)) as Hex }));
  const paid = encodeV2PayRequest(
    v2({ requestId: ("0x" + "42".repeat(16)) as Hex, expiresAt: NOW - 5, amountBaseUnits: 1n }),
  );
  const expired = encodeV2PayRequest(
    v2({ requestId: ("0x" + "43".repeat(16)) as Hex, expiresAt: NOW - 20 }),
  );
  const cancelled = encodeV2PayRequest(v2({ requestId: ("0x" + "44".repeat(16)) as Hex }));
  const model = buildMerchantDashboard({
    merchant: MERCHANT,
    records: [
      stored(open, { createdAt: "2026-10-01T00:00:00.000Z" }),
      stored(paid, { createdAt: "2026-10-04T12:00:00.000Z", paidTx: TX }),
      stored(expired, { createdAt: "2026-10-02T00:00:00.000Z" }),
      stored(cancelled, { createdAt: null, cancelled: true }),
    ],
    nowSeconds: NOW,
  });
  const activity = buildActivity(model);
  const paidEntries = activity.filter((entry) => entry.token === paid);
  assert.deepEqual(
    paidEntries.map((entry) => entry.kind),
    ["created", "paid", "transaction", "receipt"],
  );
  const paidFact = paidEntries.find((entry) => entry.kind === "paid");
  assert.equal(paidFact?.at, null);
  assert.match(paidFact?.note ?? "", /not the paid time/);
  assert.equal(paidEntries.find((entry) => entry.kind === "transaction")?.at, null);
  assert.equal(paidEntries.find((entry) => entry.kind === "receipt")?.detail, `/r/${TX}`);
  const expiredFact = activity.find((entry) => entry.kind === "expired");
  assert.equal(expiredFact?.timeLabel, "Expiry");
  assert.equal(expiredFact?.at, new Date((NOW - 20) * 1000).toISOString());
  assert.match(expiredFact?.note ?? "", /not a recorded event time/);
  const cancelledFact = activity.find((entry) => entry.kind === "cancelled");
  assert.equal(cancelledFact?.at, null);
  assert.match(cancelledFact?.note ?? "", /not stored/);
  assert.equal(activity.some((entry) => entry.kind === "paid" && entry.at != null), false);

  const analytics = buildAnalytics(model);
  assert.equal(analytics.paid, 1);
  assert.equal(analytics.outstandingBaseUnits, 1_500_000n);
  assert.deepEqual(
    analytics.createdByDay.map((bucket) => bucket.date),
    ["2026-10-04", "2026-10-02", "2026-10-01"],
  );
  assert.equal(analytics.missingCreatedAt, 1);
  assert.equal(analytics.createdByDay.reduce((sum, bucket) => sum + bucket.count, 0), 3);
  assert.equal(buildActivity(emptyDashboard(true)).length, 0);
  assert.equal(buildAnalytics(emptyDashboard(false)).total, 0);
});

test("lookup, share targets, and store errors stay inside this wallet", () => {
  const token = encodeV2PayRequest(v2());
  const model = buildMerchantDashboard({
    merchant: MERCHANT,
    records: [stored(token)],
    nowSeconds: NOW,
  });
  assert.equal(lookupWorkspaceRequest(model, token).state, "found");
  assert.equal(lookupWorkspaceRequest(model, "%%%").state, "invalid");
  assert.equal(lookupWorkspaceRequest(model, "").state, "invalid");
  const other = encodePayRequest({ to: OTHER, amount: "1", memo: "nope" });
  assert.equal(lookupWorkspaceRequest(model, other).state, "missing");
  assert.deepEqual(shareTargets(model.rows[0]), ["payment", "requestId"]);
  const paid = buildMerchantDashboard({
    merchant: MERCHANT,
    records: [stored(encodePayRequest({ to: MERCHANT, amount: "1", memo: "v1" }), { paidTx: TX })],
    nowSeconds: NOW,
  }).rows[0];
  assert.equal(paid.requestId, null);
  assert.equal(paid.memoId, null);
  assert.deepEqual(shareTargets(paid), ["receipt", "transaction"]);
  assert.equal(presentWorkspaceError("Unable to verify payment status."), "Unable to verify payment status.");
  assert.equal(presentWorkspaceError("Could not load payment requests."), "Could not load payment requests.");
  assert.equal(
    presentWorkspaceError("ENOENT /workspace/data/pay-store.json\n at readStore"),
    "Payment requests could not be loaded.",
  );
  assert.equal(presentWorkspaceError("redis token=secret"), "Payment requests could not be loaded.");
  assert.equal(presentWorkspaceError(null), null);
});

test("dashboard sources do not call reconciliation or mark a payment paid", () => {
  const forbidden = [
    "reconcilePaymentRecord",
    "findSettlementProof",
    "findProofV2",
    "verifyReceiptForRequest",
    "markPaid",
    "Mark Paid",
    "mark as paid",
  ];
  function filesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...filesUnder(full));
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }
  const files = [
    join(process.cwd(), "src/lib/merchantDashboard.ts"),
    ...filesUnder(join(process.cwd(), "src/components/dashboard")),
    ...filesUnder(join(process.cwd(), "src/app/dashboard")),
  ];
  assert.ok(files.length > 5);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const name of forbidden) {
      assert.equal(text.includes(name), false, `${file} mentions ${name}`);
    }
  }
});
