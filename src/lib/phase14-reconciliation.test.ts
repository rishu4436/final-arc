/**
 * Phase 14 — reconciliation architecture tests.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_CHAIN_ID } from "./arc";
import { signFinalRequest, validateFinalRequest, type FinalRequest } from "./finalRequest";
import { encodePayRequest, encodeV2PayRequest } from "./payRequest";
import { payGet, payPost, statementGet, type PayStatusDeps } from "./payStatusHttp";
import {
  DuplicateRequestError,
  MAX_SUBMITTED_HASHES,
  addSubmittedHash,
  applySettlementToStore,
  createPayRecord,
  isLateSettlement,
  mutatePayStoreBlob,
  nextPaidRecord,
  settleRecord,
  type PaidProof,
  type PayRecord,
  type StoreFile,
} from "./payStore";
import {
  paymentPaidEventId,
  reconcileOnePayment,
  submitTransactionHash,
  enqueuePaymentPaidInStore,
} from "./settlement";
import { EMITTABLE_WEBHOOK_EVENTS } from "./webhooksCatalog";

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const MERCHANT = privateKeyToAccount(KEY).address;
const TX_A = ("0x" + "aa".repeat(32)) as Hash;
const TX_B = ("0x" + "bb".repeat(32)) as Hash;
const TX_C = ("0x" + "cc".repeat(32)) as Hash;
const REQUEST_A = ("0x" + "11".repeat(16)) as Hex;
const NONCE_A = ("0x" + "a1".repeat(32)) as Hex;
const EXPIRES = 1_900_000_000;
const NOW = 1_700_000_000;

const ENV_KEYS = ["FINAL_PAY_STORE", "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

async function withFileStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "final-p14-"));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.FINAL_PAY_STORE = join(dir, "pay.json");
  try {
    return await fn(dir);
  } finally {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function blank(token: string, over: Partial<PayRecord> = {}): PayRecord {
  return {
    token,
    id: "legacy",
    to: MERCHANT,
    amount: "0.01",
    memo: "p14",
    createdAt: "2026-10-06T00:00:00.000Z",
    views: 0,
    lastViewedAt: null,
    cancelled: false,
    cancelledAt: null,
    paidTx: null,
    webhookUrl: null,
    ...over,
  };
}

async function v2(): Promise<{ token: string; request: FinalRequest; proof: PaidProof }> {
  const fields = validateFinalRequest({
    version: 2,
    requestId: REQUEST_A,
    merchant: MERCHANT,
    recipient: MERCHANT,
    amountBaseUnits: 10_000n,
    memo: "P14-TEST",
    chainId: ARC_CHAIN_ID,
    expiresAt: EXPIRES,
    nonce: NONCE_A,
  });
  const request = await signFinalRequest(fields, KEY);
  const token = encodeV2PayRequest(request);
  const proof: PaidProof = {
    version: 2,
    tx: TX_A,
    requestId: REQUEST_A,
    blockTimestamp: NOW,
    expiresAt: EXPIRES,
  };
  return { token, request, proof };
}

test("payment.paid is in EMITTABLE_WEBHOOK_EVENTS", () => {
  assert.equal((EMITTABLE_WEBHOOK_EVENTS as readonly string[]).includes("payment.paid"), true);
  assert.equal((EMITTABLE_WEBHOOK_EVENTS as readonly string[]).includes("payment.detected"), false);
  assert.equal((EMITTABLE_WEBHOOK_EVENTS as readonly string[]).includes("payment.verified"), false);
  assert.equal((EMITTABLE_WEBHOOK_EVENTS as readonly string[]).includes("payment.failed"), false);
});

test("GET endpoints do not call findSettlementProof", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "0.01", memo: "x" });
  let finds = 0;
  const records = new Map<string, PayRecord>([[token, blank(token)]]);
  const deps: PayStatusDeps = {
    getRecord: async (t) => records.get(t) ?? null,
    listByPayee: async (to) => [...records.values()].filter((r) => r.to.toLowerCase() === to.toLowerCase()),
    markCancelled: async () => null,
    markPaid: async () => null,
    markViewed: async (t) => records.get(t) ?? null,
    upsertRecord: async (r) => r,
    createOwnedRecord: async (r) => ({ record: r, created: true }),
    findSettlementProof: async () => {
      finds += 1;
      return null;
    },
    loadMemoLedger: async () => [],
    authorize: async () => ({ ok: true as const, merchant: MERCHANT }),
    rateLimit: () => true,
    clientKey: () => "ip:t",
  };
  await payGet(new Request(`http://localhost/api/pay?token=${encodeURIComponent(token)}`), deps);
  await payGet(new Request(`http://localhost/api/pay?to=${MERCHANT}`), deps);
  await statementGet(new Request(`http://localhost/api/statement?address=${MERCHANT}`), deps);
  assert.equal(finds, 0);
});

test("submitted hash alone is not PAID", async () => {
  await withFileStore(async () => {
    const { token, proof } = await v2();
    const row = blank(token, { id: REQUEST_A, amount: "0.01", memo: "P14-TEST" });
    await mutatePayStoreBlob((s) => {
      s.records[token] = row;
    });
    const outcome = await submitTransactionHash({
      token,
      txHash: TX_A,
      row,
      lookup: { version: 1, to: MERCHANT, amount: "0.01", memo: "P14-TEST" },
      verify: async () => ({ status: "not_found" }),
      settle: async () => ({ ok: false, code: "rejected", record: row, deliveryIds: [], eventId: null }),
      addCandidate: addSubmittedHash,
    });
    assert.equal(outcome.kind, "candidate");
    if (outcome.kind !== "candidate") return;
    assert.equal(outcome.record.paidTx, null);
    assert.equal((outcome.record.submittedHashes ?? []).includes(TX_A), true);
    void proof;
  });
});

test("valid submitted proof settles to PAID with transitioned webhook enqueue", async () => {
  await withFileStore(async () => {
    const { token, proof } = await v2();
    await mutatePayStoreBlob((s) => {
      s.records[token] = blank(token, { id: REQUEST_A, amount: "0.01", memo: "P14-TEST" });
      s.webhooks = {
        endpoints: {
          wh1: {
            id: "wh1",
            merchant: MERCHANT,
            url: "https://hooks.example.com/h",
            enabled: true,
            events: ["payment.paid"],
            secret: "x".repeat(32),
            createdAt: "2026-10-06T00:00:00.000Z",
            updatedAt: "2026-10-06T00:00:00.000Z",
          },
        },
        deliveries: {},
      };
    });
    const { getRecord } = await import("./payStore");
    const live = await getRecord(token);
    assert.ok(live);
    const { request } = await v2();
    const outcome = await submitTransactionHash({
      token,
      txHash: TX_A,
      row: live!,
      lookup: { version: 2, request, cancelled: false },
      verify: async () => ({ status: "proof", proof }),
      addCandidate: addSubmittedHash,
    });
    assert.equal(outcome.kind, "paid");
    if (outcome.kind !== "paid") return;
    assert.equal(outcome.transitioned, true);
    assert.equal(outcome.record.paidTx, TX_A);
    const eventId = paymentPaidEventId(outcome.record, TX_A);
    assert.match(eventId, /^evt_paid_[0-9a-f]{32}$/);
  });
});

test("duplicate reconciliation is idempotent and does not re-transition", async () => {
  await withFileStore(async () => {
    const { token, proof } = await v2();
    await mutatePayStoreBlob((s) => {
      s.records[token] = blank(token, { id: REQUEST_A, paidTx: TX_A, paidBlockTimestamp: NOW });
    });
    const live = await (await import("./payStore")).getRecord(token);
    const first = await settleRecord(token, proof);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.transitioned, false);
    assert.equal(live?.paidTx, TX_A);
  });
});

test("same tx cannot settle two requests (settlement_used)", async () => {
  await withFileStore(async () => {
    const { proof } = await v2();
    const t1 = "tok-1";
    const t2 = "tok-2";
    await mutatePayStoreBlob((s) => {
      s.records[t1] = blank(t1, { id: REQUEST_A, paidTx: TX_A });
      s.records[t2] = blank(t2, { id: ("0x" + "22".repeat(16)) as string });
    });
    const store: StoreFile = { records: {} };
    await mutatePayStoreBlob((s) => {
      Object.assign(store, s);
    });
    // Fresh apply against live blob
    let code: string | null = null;
    await mutatePayStoreBlob((s) => {
      const result = applySettlementToStore(s, t2, { version: 1, tx: TX_A });
      code = result.ok ? "ok" : result.code;
    });
    assert.equal(code, "settlement_used");
    void proof;
  });
});

test("payment-before-cancel: mined before cancel supersedes CANCELLED", () => {
  const row = blank("t", {
    id: REQUEST_A,
    cancelled: true,
    cancelledAt: "2026-10-06T01:00:00.000Z",
    cancelledAtSeconds: NOW + 100,
  });
  const proof: PaidProof = {
    version: 2,
    tx: TX_A,
    requestId: REQUEST_A,
    blockTimestamp: NOW + 50,
    expiresAt: EXPIRES,
  };
  const next = nextPaidRecord(row, proof);
  assert.ok(next);
  assert.equal(next!.paidTx, TX_A);
  assert.equal(next!.cancelled, false);
});

test("payment-before-cancel: mined at/after cancel stays CANCELLED (late)", () => {
  const row = blank("t", {
    id: REQUEST_A,
    cancelled: true,
    cancelledAt: "2026-10-06T01:00:00.000Z",
    cancelledAtSeconds: NOW,
  });
  const proof: PaidProof = {
    version: 2,
    tx: TX_A,
    requestId: REQUEST_A,
    blockTimestamp: NOW,
    expiresAt: EXPIRES,
  };
  assert.equal(nextPaidRecord(row, proof), null);
  assert.equal(isLateSettlement(row, proof), true);
});

test("post-expiry proof is rejected", () => {
  const row = blank("t", { id: REQUEST_A });
  const proof: PaidProof = {
    version: 2,
    tx: TX_A,
    requestId: REQUEST_A,
    blockTimestamp: EXPIRES,
    expiresAt: EXPIRES,
  };
  assert.equal(nextPaidRecord(row, proof), null);
});

test("candidate hash cap is MAX_SUBMITTED_HASHES", async () => {
  await withFileStore(async () => {
    const token = "cap";
    await mutatePayStoreBlob((s) => {
      s.records[token] = blank(token, {
        submittedHashes: [TX_A, TX_B, TX_C],
      });
    });
    const again = await addSubmittedHash(token, ("0x" + "dd".repeat(32)) as Hash);
    assert.equal((again?.submittedHashes ?? []).length, MAX_SUBMITTED_HASHES);
  });
});

test("requestId uniqueness on create", async () => {
  await withFileStore(async () => {
    const { token } = await v2();
    await createPayRecord(blank(token, { id: REQUEST_A }), MERCHANT);
    const otherToken = token + "x";
    await assert.rejects(
      () => createPayRecord(blank(otherToken, { id: REQUEST_A }), MERCHANT),
      (err: unknown) => err instanceof DuplicateRequestError,
    );
  });
});

test("paidTx is immutable under different proof", async () => {
  await withFileStore(async () => {
    const token = "imm";
    await mutatePayStoreBlob((s) => {
      s.records[token] = blank(token, { paidTx: TX_A });
    });
    const result = await settleRecord(token, { version: 1, tx: TX_B });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "already_paid_different");
  });
});

test("enqueuePaymentPaidInStore is idempotent for same event", () => {
  const row = blank("t", { id: REQUEST_A, paidTx: TX_A, to: MERCHANT });
  const store: StoreFile = {
    records: { t: row },
    webhooks: {
      endpoints: {
        wh1: {
          id: "wh1",
          merchant: MERCHANT,
          url: "https://hooks.example.com/h",
          enabled: true,
          events: ["payment.paid"],
          secret: "plain",
          createdAt: "2026-10-06T00:00:00.000Z",
          updatedAt: "2026-10-06T00:00:00.000Z",
        },
      },
      deliveries: {},
    },
  };
  const first = enqueuePaymentPaidInStore(store, row, TX_A, NOW);
  const second = enqueuePaymentPaidInStore(store, row, TX_A, NOW);
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(Object.keys(store.webhooks!.deliveries).length, 1);
});

test("reconcileOnePayment tries candidates before scan", async () => {
  let scanned = 0;
  const verified: string[] = [];
  const row = blank("t", { id: REQUEST_A, submittedHashes: [TX_A] });
  const proof: PaidProof = { version: 1, tx: TX_A };
  const outcome = await reconcileOnePayment({
    row,
    allowScan: true,
    verify: async (_lookup, hash) => {
      verified.push(hash);
      return { status: "proof", proof: { version: 1, tx: hash } };
    },
    findProof: async () => {
      scanned += 1;
      return null;
    },
    settle: async (_token, p) => ({
      ok: true,
      record: { ...row, paidTx: p.tx },
      transitioned: true,
      deliveryIds: [],
      eventId: null,
    }),
  });
  assert.equal(outcome.kind, "paid");
  assert.equal(scanned, 0);
  assert.deepEqual(verified, [TX_A]);
  void proof;
});

test("malformed submit tx hash is 400", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "0.01", memo: "x" });
  const records = new Map([[token, blank(token)]]);
  const deps: PayStatusDeps = {
    getRecord: async (t) => records.get(t) ?? null,
    listByPayee: async () => [],
    markCancelled: async () => null,
    markPaid: async () => null,
    markViewed: async () => null,
    upsertRecord: async (r) => r,
    createOwnedRecord: async (r) => ({ record: r, created: true }),
    findSettlementProof: async () => null,
    loadMemoLedger: async () => [],
    authorize: async () => ({ ok: true as const, merchant: MERCHANT }),
    rateLimit: () => true,
    clientKey: () => "ip:t",
  };
  const result = await payPost(
    new Request("http://localhost/api/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "submit", token, txHash: "0xdead" }),
    }),
    deps,
  );
  assert.equal(result.status, 400);
  assert.equal("code" in result.body && result.body.code, "invalid_tx_hash");
});

test("merchant reconcile requires auth", async () => {
  const token = encodePayRequest({ to: MERCHANT, amount: "0.01", memo: "x" });
  const records = new Map([[token, blank(token)]]);
  const deps: PayStatusDeps = {
    getRecord: async (t) => records.get(t) ?? null,
    listByPayee: async () => [],
    markCancelled: async () => null,
    markPaid: async () => null,
    markViewed: async () => null,
    upsertRecord: async (r) => r,
    createOwnedRecord: async (r) => ({ record: r, created: true }),
    findSettlementProof: async () => null,
    loadMemoLedger: async () => [],
    authorize: async () => ({
      status: 401,
      body: { error: { code: "unauthorized", message: "API authentication required" } },
    }),
    rateLimit: () => true,
    clientKey: () => "ip:t",
  };
  const result = await payPost(
    new Request("http://localhost/api/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reconcile", token }),
    }),
    deps,
  );
  assert.equal(result.status, 401);
});

test("dashboard/analytics/observe source stay free of markPaid", async () => {
  const { readFileSync } = await import("node:fs");
  const root = new URL("../..", import.meta.url);
  for (const rel of [
    "src/lib/checkoutObserve.ts",
    "src/lib/analytics.ts",
    "src/components/dashboard/MerchantData.tsx",
  ]) {
    const text = readFileSync(new URL(rel, root), "utf8");
    assert.equal(text.includes("reconcilePaymentRecord"), false, rel);
    assert.equal(text.includes("markPaid"), false, rel);
    assert.equal(text.includes("findSettlementProof"), false, rel);
  }
});

test("payStatusHttp source has no withPaid", async () => {
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(new URL("./payStatusHttp.ts", import.meta.url), "utf8");
  assert.equal(text.includes("withPaid"), false);
  assert.equal(text.includes("reconcilePaymentRecord"), false);
});
