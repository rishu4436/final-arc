import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex } from "viem";
import { ARC_CHAIN_ID } from "./arc";
import { signPaymentCancellation } from "./finalCancel";
import type { FinalRequest } from "./finalRequest";
import { encodePayRequest, encodeV2PayRequest } from "./payRequest";
import { payGet, payPost, statementGet, type PayStatusDeps } from "./payStatusHttp";
import { paySheetOffer } from "./paySheetStatus";
import { PAYMENT_STATUS_UNAVAILABLE, reconcilePaymentRecord } from "./reconcilePayment";
import { nextCancelledRecord, nextPaidRecord, type PaidProof, type PayRecord } from "./payStore";

const MERCHANT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const MERCHANT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const REQUEST_A = ("0x" + "11".repeat(16)) as Hex;
const NONCE_A = ("0x" + "a1".repeat(32)) as Hex;
const TX = ("0x" + "ab".repeat(32)) as Hex;
const LEAK = "https://rpc.mainnet.arc.io/secret KV_REST_API_TOKEN=super-secret UPSTASH_REDIS_REST_URL=https://example.upstash.io";

function row(token: string, overrides: Partial<PayRecord> = {}): PayRecord {
  return {
    token,
    id: "legacy",
    to: MERCHANT,
    amount: "0.2",
    memo: "note",
    createdAt: "2026-10-04T00:00:00.000Z",
    views: 0,
    lastViewedAt: null,
    cancelled: false,
    cancelledAt: null,
    paidTx: null,
    webhookUrl: null,
    ...overrides,
  };
}

function v2Request(): FinalRequest {
  return {
    version: 2,
    requestId: REQUEST_A,
    merchant: MERCHANT,
    recipient: MERCHANT,
    amountBaseUnits: 200_000n,
    memo: "PAGED-RECON-TEST-1",
    chainId: ARC_CHAIN_ID,
    expiresAt: 1_900_000_000,
    nonce: NONCE_A,
    signature: ("0x" + "11".repeat(65)) as Hex,
  };
}

function proof(): PaidProof {
  return { version: 1, tx: TX };
}

function deps(options: {
  records?: PayRecord[];
  find?: PayStatusDeps["findSettlementProof"];
  failRead?: boolean;
  failWrite?: boolean;
  ledger?: PayStatusDeps["loadMemoLedger"];
}) {
  const records = new Map((options.records ?? []).map((record) => [record.token, record]));
  const calls = { find: 0, paid: 0, cancelled: 0, read: 0, write: 0 };
  const find = options.find ?? (async () => null);
  const store: PayStatusDeps = {
    async getRecord(token) {
      calls.read += 1;
      if (options.failRead) throw new Error(LEAK);
      return records.get(token) ?? null;
    },
    async listByPayee(to) {
      calls.read += 1;
      if (options.failRead) throw new Error(LEAK);
      return [...records.values()].filter((record) => record.to.toLowerCase() === to.toLowerCase());
    },
    async markCancelled(token, command) {
      calls.cancelled += 1;
      calls.write += 1;
      if (options.failWrite) throw new Error(LEAK);
      const current = records.get(token);
      if (!current) return null;
      const next = nextCancelledRecord(current, "2026-10-04T08:00:00.000Z", command);
      records.set(token, next);
      return next;
    },
    async markPaid(token, nextProof) {
      calls.paid += 1;
      calls.write += 1;
      if (options.failWrite) throw new Error(LEAK);
      const current = records.get(token);
      if (!current) return null;
      const next = nextPaidRecord(current, nextProof);
      if (!next) return null;
      records.set(token, next);
      return next;
    },
    async markViewed(token) {
      const current = records.get(token);
      if (!current) return null;
      const next = { ...current, views: current.views + 1, lastViewedAt: "2026-10-04T08:00:00.000Z" };
      records.set(token, next);
      return next;
    },
    async upsertRecord(record) {
      calls.write += 1;
      if (options.failWrite) throw new Error(LEAK);
      const existing = records.get(record.token);
      const next = existing ?? record;
      records.set(record.token, next);
      return next;
    },
    async findSettlementProof(lookup) {
      calls.find += 1;
      return find(lookup);
    },
    loadMemoLedger: options.ledger ?? (async () => []),
    // Phase 13: legacy merchant reads/V1 register require auth. These fixtures act as the payee.
    authorize: async () => ({ ok: true as const, merchant: MERCHANT }),
    createOwnedRecord: async (record) => {
      const existing = records.get(record.token);
      if (existing) return { record: existing, created: false };
      records.set(record.token, record);
      return { record, created: true };
    },
    rateLimit: () => true,
    clientKey: () => "ip:test",
    emitCreated: () => {},
    emitCancelled: () => {},
  };
  return { store, calls, current: (token: string) => records.get(token) ?? null };
}

function get(url: string) {
  return new Request(url);
}

function post(body: unknown) {
  return new Request("http://localhost/api/pay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function assertSafe(body: unknown) {
  const text = JSON.stringify(body);
  assert.equal(text.includes("http"), false);
  assert.equal(text.includes("rpc"), false);
  assert.equal(text.includes("KV_"), false);
  assert.equal(text.includes("UPSTASH"), false);
  assert.equal(text.includes("secret"), false);
  assert.equal(text.includes("upstash"), false);
  assert.deepEqual(body, { error: PAYMENT_STATUS_UNAVAILABLE });
}

test("no settlement stays unpaid", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "0.2", memo: "note" });
  const { store, calls } = deps({ records: [row(token)] });
  const result = await payGet(get(`http://localhost/api/pay?token=${encodeURIComponent(token)}`), store);
  assert.equal(result.status, 200);
  assert.equal("record" in result.body && result.body.record.paidTx, null);
  assert.equal(calls.paid, 0);
  assert.equal(calls.find, 1);
});

test("a settlement is recorded as paid", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "0.2", memo: "note" });
  const { store } = deps({ records: [row(token)], find: async () => proof() });
  const result = await payGet(get(`http://localhost/api/pay?token=${encodeURIComponent(token)}`), store);
  assert.equal(result.status, 200);
  assert.equal("record" in result.body && result.body.record.paidTx, TX);
});

test("an RPC failure is 503 and not an unpaid record", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "0.2", memo: "note" });
  const { store, calls, current } = deps({
    records: [row(token)],
    find: async () => {
      throw new Error(LEAK);
    },
  });
  const result = await payGet(get(`http://localhost/api/pay?token=${encodeURIComponent(token)}`), store);
  assert.equal(result.status, 503);
  assert.equal("record" in result.body, false);
  assertSafe(result.body);
  assert.equal(current(token)?.paidTx, null);
  assert.equal(current(token)?.cancelled, false);
  assert.equal(calls.paid, 0);
  assert.equal(calls.cancelled, 0);
});

test("a Redis read failure is 503 and not an unpaid record", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "0.2", memo: "note" });
  const { store, calls } = deps({ failRead: true, records: [row(token)] });
  const result = await payGet(get(`http://localhost/api/pay?token=${encodeURIComponent(token)}`), store);
  assert.equal(result.status, 503);
  assertSafe(result.body);
  assert.equal(calls.find, 0);
});

test("a Redis write failure is 503 and not an unpaid record", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "0.2", memo: "note" });
  const { store, calls, current } = deps({
    records: [row(token)],
    find: async () => proof(),
    failWrite: true,
  });
  const result = await payGet(get(`http://localhost/api/pay?token=${encodeURIComponent(token)}`), store);
  assert.equal(result.status, 503);
  assertSafe(result.body);
  assert.equal(current(token)?.paidTx, null);
  assert.equal(calls.paid, 1);
  assert.equal(calls.cancelled, 0);
});

test("an already paid row stays paid when a later scan would fail", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "0.2", memo: "note" });
  const { store, calls } = deps({
    records: [row(token, { paidTx: TX })],
    find: async () => {
      throw new Error(LEAK);
    },
  });
  const result = await payGet(get(`http://localhost/api/pay?token=${encodeURIComponent(token)}`), store);
  assert.equal(result.status, 200);
  assert.equal("record" in result.body && result.body.record.paidTx, TX);
  assert.equal(calls.find, 0);
});

test("an already cancelled row stays cancelled and is not scanned", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "0.2", memo: "note" });
  const { store, calls } = deps({
    records: [row(token, { cancelled: true, cancelledAt: "2026-10-04T01:00:00.000Z" })],
    find: async () => {
      throw new Error(LEAK);
    },
  });
  const result = await payGet(get(`http://localhost/api/pay?token=${encodeURIComponent(token)}`), store);
  assert.equal(result.status, 200);
  assert.equal("record" in result.body && result.body.record.cancelled, true);
  assert.equal("record" in result.body && result.body.record.paidTx, null);
  assert.equal(calls.find, 0);
});

test("a thrown provider error is not copied into the response", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "0.2", memo: "note" });
  const open = row(token);
  await assert.rejects(
    () =>
      reconcilePaymentRecord(open, {
        findSettlementProof: async () => {
          throw new Error(LEAK);
        },
        markPaid: async () => open,
      }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      if (!(error instanceof Error)) return false;
      assert.equal(error.message, PAYMENT_STATUS_UNAVAILABLE);
      assert.equal(error.message.includes("http"), false);
      assert.equal(error.message.includes("KV_"), false);
      return true;
    },
  );
});

// Phase 13 (P1-05): register and view no longer reach reconciliation, so a failing
// settlement lookup cannot affect them and they never scan the chain. Previously this
// test expected 503 because both actions reconciled on every public call.
test("register and view do not scan the chain, so a failing lookup is not reached", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "0.2", memo: "note" });
  const failing = async () => {
    throw new Error(LEAK);
  };
  const registered = deps({ records: [row(token)], find: failing });
  const registerResult = await payPost(post({ token, action: "register" }), registered.store);
  assert.equal(registerResult.status, 200);
  assert.equal(registered.calls.find, 0);
  assert.equal(registered.calls.cancelled, 0);
  assert.equal(registered.calls.paid, 0);
  const viewed = deps({ records: [row(token)], find: failing });
  const viewResult = await payPost(post({ token, action: "view" }), viewed.store);
  assert.equal(viewResult.status, 200);
  assert.equal(viewed.calls.find, 0);
  assert.equal(viewed.current(token)?.paidTx, null);
  assert.equal(viewed.calls.cancelled, 0);
});

test("a V1 link with no settlement stays unpaid", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "1.5", memo: "legacy-memo" });
  const { store, calls } = deps({ records: [row(token, { amount: "1.5", memo: "legacy-memo" })] });
  const result = await payPost(post({ token, action: "view" }), store);
  assert.equal(result.status, 200);
  assert.equal("record" in result.body && result.body.record.paidTx, null);
  assert.equal("record" in result.body && result.body.record.memo, "legacy-memo");
  assert.equal(calls.paid, 0);
});

test("a cancellation scan failure is 503 and does not cancel", async () => {
  const request = v2Request();
  const token = encodeV2PayRequest(request);
  const { store, calls, current } = deps({
    records: [row(token, { id: REQUEST_A, amount: "0.2", memo: request.memo })],
    find: async () => {
      throw new Error(LEAK);
    },
  });
  const signature = await signPaymentCancellation(request, MERCHANT_KEY);
  const result = await payPost(post({ token, action: "cancel", signature }), store);
  assert.equal(result.status, 503);
  assertSafe(result.body);
  assert.equal(calls.cancelled, 0);
  assert.equal(current(token)?.cancelled, false);
  assert.equal(current(token)?.paidTx, null);
});

test("a null cancellation scan still cancels", async () => {
  const request = v2Request();
  const token = encodeV2PayRequest(request);
  const { store, calls } = deps({
    records: [row(token, { id: REQUEST_A, amount: "0.2", memo: request.memo })],
    find: async () => null,
  });
  const signature = await signPaymentCancellation(request, MERCHANT_KEY);
  const result = await payPost(post({ token, action: "cancel", signature }), store);
  assert.equal(result.status, 200);
  assert.equal("record" in result.body && result.body.record.cancelled, true);
  assert.equal("record" in result.body && result.body.record.paidTx, null);
  assert.equal(calls.cancelled, 1);
});

test("a settlement found during cancellation is paid and not cancelled", async () => {
  const request = v2Request();
  const token = encodeV2PayRequest(request);
  const paid = {
    version: 2 as const,
    tx: TX,
    requestId: REQUEST_A,
    blockTimestamp: 1_800_000_000,
    expiresAt: request.expiresAt,
  };
  const { store, calls } = deps({
    records: [row(token, { id: REQUEST_A, amount: "0.2", memo: request.memo })],
    find: async () => paid,
  });
  const signature = await signPaymentCancellation(request, MERCHANT_KEY);
  const result = await payPost(post({ token, action: "cancel", signature }), store);
  assert.equal(result.status, 200);
  assert.equal("record" in result.body && result.body.record.paidTx, TX);
  assert.equal("record" in result.body && result.body.record.cancelled, false);
  assert.equal(calls.cancelled, 0);
});

test("one failed settlement scan does not return an unpaid payee list", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "0.2", memo: "note" });
  const { store } = deps({
    records: [row(token)],
    find: async () => {
      throw new Error(LEAK);
    },
  });
  const result = await payGet(get(`http://localhost/api/pay?to=${MERCHANT}`), store);
  assert.equal(result.status, 503);
  assert.equal("records" in result.body, false);
  assertSafe(result.body);
});

test("a statement ledger failure is 503 and not an empty authoritative list", async () => {
  const { store, calls } = deps({
    ledger: async () => {
      throw new Error(LEAK);
    },
  });
  const result = await statementGet(get(`http://localhost/api/statement?address=${MERCHANT}`), store);
  assert.equal(result.status, 503);
  assert.equal("links" in result.body, false);
  assert.equal("payments" in result.body, false);
  assertSafe(result.body);
  assert.equal(calls.find, 0);
});

test("a statement settlement failure is 503 and does not mark the link unpaid", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "0.2", memo: "note" });
  const { store, calls, current } = deps({
    records: [row(token)],
    find: async () => {
      throw new Error(LEAK);
    },
  });
  const result = await statementGet(get(`http://localhost/api/statement?address=${MERCHANT}`), store);
  assert.equal(result.status, 503);
  assert.equal("links" in result.body, false);
  assertSafe(result.body);
  assert.equal(current(token)?.paidTx, null);
  assert.equal(calls.paid, 0);
});

test("a statement with no settlement still lists the unpaid link", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "0.2", memo: "note" });
  const { store } = deps({ records: [row(token)] });
  const result = await statementGet(get(`http://localhost/api/statement?address=${MERCHANT}`), store);
  assert.equal(result.status, 200);
  assert.equal("links" in result.body && result.body.links.length, 1);
  assert.equal("links" in result.body && result.body.links[0]?.paidTx, null);
  assert.equal("payments" in result.body && result.body.payments.length, 0);
});

test("the pay route returns the helper status", async () => {
  const { GET } = await import("../app/api/pay/route");
  const { GET: statement } = await import("../app/api/statement/route");
  const missing = await GET(get("http://localhost/api/pay"));
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "token or to required" });
  const bad = await statement(get("http://localhost/api/statement"));
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "Valid address required." });
});

test("unknown status does not offer Pay", () => {
  const offer = paySheetOffer({
    availability: "unknown",
    paid: false,
    cancelled: false,
    expiresAt: null,
    nowSeconds: 1,
  });
  assert.equal(offer.availability, "unknown");
  assert.equal(offer.offersPay, false);
  assert.equal(offer.showsReceipt, false);
});

test("a successful open status offers Pay", () => {
  const offer = paySheetOffer({
    availability: "ready",
    paid: false,
    cancelled: false,
    expiresAt: 1_900_000_000,
    nowSeconds: 1_700_000_000,
  });
  assert.equal(offer.availability, "ready");
  if (offer.availability !== "ready") return;
  assert.equal(offer.phase, "OPEN");
  assert.equal(offer.offersPay, true);
  assert.equal(offer.showsReceipt, false);
});

test("a successful paid status offers the receipt and not Pay", () => {
  const offer = paySheetOffer({
    availability: "ready",
    paid: true,
    cancelled: false,
    expiresAt: 1_900_000_000,
    nowSeconds: 1_700_000_000,
  });
  assert.equal(offer.showsReceipt, true);
  assert.equal(offer.offersPay, false);
  if (offer.availability !== "ready") return;
  assert.equal(offer.phase, "PAID");
});

test("a failed status does not offer Pay", () => {
  const offer = paySheetOffer({
    availability: "failed",
    paid: false,
    cancelled: false,
    expiresAt: null,
    nowSeconds: 1,
  });
  assert.equal(offer.availability, "failed");
  assert.equal(offer.offersPay, false);
  assert.equal(offer.showsReceipt, false);
});

test("a later success moves from failed to open or paid", () => {
  const failed = paySheetOffer({
    availability: "failed",
    paid: false,
    cancelled: false,
    expiresAt: null,
    nowSeconds: 1,
  });
  assert.equal(failed.offersPay, false);
  const open = paySheetOffer({
    availability: "ready",
    paid: false,
    cancelled: false,
    expiresAt: null,
    nowSeconds: 1,
  });
  assert.equal(open.offersPay, true);
  const paid = paySheetOffer({
    availability: "ready",
    paid: true,
    cancelled: false,
    expiresAt: null,
    nowSeconds: 1,
  });
  assert.equal(paid.showsReceipt, true);
  assert.equal(paid.offersPay, false);
});
