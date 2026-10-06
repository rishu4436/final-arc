import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type Address, type Hash, type Hex } from "viem";
import { ARC_CHAIN_ID } from "./arc";
import { observeCheckoutRecord } from "./checkoutObserve";
import type { FinalRequest } from "./finalRequest";
import { encodePayRequest, encodeV2PayRequest } from "./payRequest";
import type { PayRecord } from "./payStore";

const MERCHANT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const REQUEST_ID = ("0x" + "ab".repeat(16)) as Hex;
const NONCE = ("0x" + "cd".repeat(32)) as Hex;
const TX = ("0x" + "11".repeat(32)) as Hash;
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

function row(token: string, overrides: Partial<PayRecord> = {}): PayRecord {
  return {
    token,
    id: "row",
    to: MERCHANT,
    amount: "999.00",
    memo: "stored-memo",
    createdAt: "2026-10-04T00:00:00.000Z",
    views: 4,
    lastViewedAt: "2026-10-04T00:00:00.000Z",
    cancelled: false,
    cancelledAt: null,
    paidTx: null,
    webhookUrl: "https://merchant.example/hook-secret",
    ...overrides,
  };
}

test("missing row is OPEN from the token and does not write", async () => {
  const token = encodeV2PayRequest(v2());
  let reads = 0;
  const result = await observeCheckoutRecord(token, {
    nowSeconds: NOW,
    getRecord: async () => {
      reads += 1;
      return null;
    },
  });
  assert.equal(reads, 1);
  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.observation.phase, "OPEN");
  assert.equal(result.body.observation.version, 2);
  assert.equal(result.body.observation.amount, "1.5");
  assert.equal(result.body.observation.requestId, REQUEST_ID);
  assert.equal(result.body.observation.merchant, MERCHANT);
  assert.equal(result.body.observation.paidTx, null);
  assert.equal(result.body.observation.cancelled, false);
  assert.equal("nonce" in result.body.observation, false);
  assert.equal("memoId" in result.body.observation, false);
});

test("stored PAID is the stored hash, not a caller hash", async () => {
  const token = encodeV2PayRequest(v2({ expiresAt: NOW - 10 }));
  const stored = row(token, { paidTx: TX });
  const before = structuredClone(stored);
  const result = await observeCheckoutRecord(token, {
    nowSeconds: NOW,
    getRecord: async () => stored,
  });
  assert.deepEqual(stored, before);
  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.observation.phase, "PAID");
  assert.equal(result.body.observation.paidTx, TX);
  assert.equal(result.body.observation.amount, "1.5");
  assert.equal(result.body.observation.memo, "INV-1");
  const json = JSON.stringify(result.body);
  assert.equal(json.includes("hook-secret"), false);
  assert.equal(json.includes("webhookUrl"), false);
  assert.equal(json.includes("999.00"), false);
});

test("a non-hash paidTx is not PAID", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "1.50", memo: "rent" });
  const result = await observeCheckoutRecord(token, {
    nowSeconds: NOW,
    getRecord: async () => row(token, { paidTx: "0xnot-a-tx" as Hash }),
  });
  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.observation.phase, "OPEN");
  assert.equal(result.body.observation.paidTx, null);
});

test("cancelled stays cancelled and V1 has no request id", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "1.50", memo: "rent" });
  const result = await observeCheckoutRecord(token, {
    nowSeconds: NOW,
    getRecord: async () => row(token, { cancelled: true, to: OTHER }),
  });
  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.observation.phase, "CANCELLED");
  assert.equal(result.body.observation.version, 1);
  assert.equal(result.body.observation.requestId, null);
  assert.equal(result.body.observation.merchant, null);
  assert.equal(result.body.observation.recipient, MERCHANT);
  assert.equal(result.body.observation.expiresAt, null);
  assert.equal(result.body.observation.memo, "rent");
  assert.equal("nonce" in result.body.observation, false);
  assert.equal("memoId" in result.body.observation, false);
});

test("unstored V2 past expiry is EXPIRED without a write", async () => {
  const token = encodeV2PayRequest(v2({ expiresAt: NOW - 1 }));
  const result = await observeCheckoutRecord(token, {
    nowSeconds: NOW,
    getRecord: async () => null,
  });
  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.observation.phase, "EXPIRED");
  assert.equal(result.body.observation.paidTx, null);
});

test("invalid token is not found and does not read the store", async () => {
  let reads = 0;
  const result = await observeCheckoutRecord("not-a-payment-link", {
    getRecord: async () => {
      reads += 1;
      return null;
    },
  });
  assert.equal(reads, 0);
  assert.equal(result.status, 404);
  if (result.status !== 404) return;
  assert.equal(result.body.error.code, "not_found");
  assert.equal(result.body.error.message.includes("store"), false);
});

test("lookup is only the requested token", async () => {
  const mine = encodePayRequest({ to: MERCHANT, amount: "1", memo: "mine" });
  const theirs = encodePayRequest({ to: OTHER, amount: "9", memo: "theirs-secret" });
  const rows = new Map<string, PayRecord>([
    [mine, row(mine, { memo: "mine" })],
    [theirs, row(theirs, { to: OTHER, memo: "theirs-secret", webhookUrl: "https://other.example/secret" })],
  ]);
  const result = await observeCheckoutRecord(mine, {
    nowSeconds: NOW,
    getRecord: async (token) => rows.get(token) ?? null,
  });
  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  const json = JSON.stringify(result.body);
  assert.equal(json.includes("theirs-secret"), false);
  assert.equal(json.includes(OTHER), false);
  assert.equal(result.body.observation.memo, "mine");
});

test("store failure does not leak and does not call writers", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "1", memo: "rent" });
  const result = await observeCheckoutRecord(token, {
    getRecord: async () => {
      throw new Error("redis token super-secret");
    },
  });
  assert.equal(result.status, 503);
  if (result.status !== 503) return;
  assert.equal(result.body.error.code, "unavailable");
  assert.equal(JSON.stringify(result.body).includes("super-secret"), false);
});

test("observe source never reconciles, marks paid, or emits webhooks", () => {
  const observe = readFileSync(new URL("./checkoutObserve.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/pay/observe/route.ts", import.meta.url), "utf8");
  const checkout = readFileSync(new URL("../components/Checkout.tsx", import.meta.url), "utf8");
  for (const source of [observe, route]) {
    assert.doesNotMatch(source, /reconcilePaymentRecord|findSettlementProof|findProofV2|verifyReceiptForRequest|markPaid|markViewed|upsertRecord/);
    assert.doesNotMatch(source, /emitPaymentRequest|emitWebhook|notifyWebhook/);
  }
  assert.match(route, /getRecord/);
  assert.match(checkout, /\/api\/pay\/observe\?token=/);
  assert.doesNotMatch(checkout, /\/api\/pay\?token=/);
  // Phase 14: Checkout POSTs action=submit with the wallet hash (never GET reconcile).
  assert.match(checkout, /action:\s*"submit"/);
  assert.equal(checkout.includes("reconcilePaymentRecord"), false);
  assert.equal(checkout.includes("markPaid"), false);
});
