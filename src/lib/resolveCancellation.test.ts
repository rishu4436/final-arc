import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex } from "viem";
import { ARC_CHAIN_ID } from "./arc";
import { signPaymentCancellation } from "./finalCancel";
import type { PayIdentity } from "./payPaid";
import {
  nextCancelledRecord,
  type CancelCommand,
  type PayRecord,
} from "./payStore";
import { resolveCancellation, type CancellationDeps } from "./resolveCancellation";
import type { FinalRequest } from "./finalRequest";

const MERCHANT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const MERCHANT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const REQUEST_A = ("0x" + "11".repeat(16)) as Hex;
const REQUEST_B = ("0x" + "22".repeat(16)) as Hex;
const NONCE_A = ("0x" + "a1".repeat(32)) as Hex;
const EXPIRES_AT = 1_800_000_000;
const NOW = 1_700_000_000;
const TOKEN = "pay-token";
const TX = ("0x" + "ab".repeat(32)) as Hex;

function request(overrides: Partial<FinalRequest> = {}): FinalRequest {
  return {
    version: 2,
    requestId: REQUEST_A,
    merchant: MERCHANT,
    recipient: MERCHANT,
    amountBaseUnits: 200_000n,
    memo: "PAGED-RECON-TEST-1",
    chainId: ARC_CHAIN_ID,
    expiresAt: EXPIRES_AT,
    nonce: NONCE_A,
    signature: "0x",
    ...overrides,
  };
}

function openRow(overrides: Partial<PayRecord> = {}): PayRecord {
  return {
    token: TOKEN,
    id: REQUEST_A,
    to: MERCHANT,
    amount: "0.2",
    memo: "PAGED-RECON-TEST-1",
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

function identity(): PayIdentity {
  return { version: 2, id: REQUEST_A, to: MERCHANT, amount: "0.2", memo: "PAGED-RECON-TEST-1" };
}

function memory(initial: PayRecord | null) {
  let row = initial;
  const calls = { paid: 0, cancelled: 0, scanned: 0 };
  const deps: CancellationDeps = {
    async getRecord(token) {
      return row && row.token === token ? row : null;
    },
    async markCancelled(token, command: CancelCommand) {
      calls.cancelled += 1;
      if (!row || row.token !== token) return null;
      if (command.version === 1) {
        if (row.to.toLowerCase() !== command.payee.toLowerCase()) return null;
      } else if (!/^0x[0-9a-fA-F]{32}$/.test(row.id) || row.id.toLowerCase() !== command.requestId.toLowerCase()) {
        return null;
      }
      const next = nextCancelledRecord(row, "2026-10-04T08:00:00.000Z", command);
      if (next === row) return row;
      row = next;
      return row;
    },
    async findSettlementProof() {
      calls.scanned += 1;
      throw new Error("Phase 14 cancel must not scan");
    },
    async ensureRecord() {
      if (!row) row = openRow();
      return row;
    },
  };
  return { deps, calls, current: () => row };
}

async function merchantSignature(row: FinalRequest = request()): Promise<Hex> {
  return signPaymentCancellation(row, MERCHANT_KEY);
}

test("Phase 14: cancel without settlement scan cancels a V2 request", async () => {
  const signed = request();
  const store = memory(openRow());
  const resolved = await resolveCancellation(
    {
      token: TOKEN,
      identity: identity(),
      lookup: { version: 2, request: signed, cancelled: false },
      signature: await merchantSignature(signed),
      nowSeconds: NOW,
    },
    store.deps,
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.record.cancelled, true);
  assert.equal(resolved.record.paidTx, null);
  assert.equal(resolved.record.cancelledAtSeconds, NOW);
  assert.equal(resolved.notify, "cancelled");
  assert.equal(store.calls.cancelled, 1);
  assert.equal(store.calls.scanned, 0);
});

test("Phase 14: cancel does not credit an on-chain settlement (no scan)", async () => {
  const signed = request();
  const store = memory(openRow());
  const resolved = await resolveCancellation(
    {
      token: TOKEN,
      identity: identity(),
      lookup: { version: 2, request: signed, cancelled: false },
      signature: await merchantSignature(signed),
      nowSeconds: NOW,
    },
    store.deps,
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  // Settlement recovery is submit/reconcile with payment-before-cancel.
  assert.equal(resolved.record.cancelled, true);
  assert.equal(resolved.record.paidTx, null);
  assert.equal(store.calls.scanned, 0);
});

test("after the clock expires, cancel is refused and not stored", async () => {
  const signed = request();
  const store = memory(openRow());
  const resolved = await resolveCancellation(
    {
      token: TOKEN,
      identity: identity(),
      lookup: { version: 2, request: signed, cancelled: false },
      signature: await merchantSignature(signed),
      nowSeconds: EXPIRES_AT,
    },
    store.deps,
  );
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.equal(resolved.status, 409);
  assert.equal(store.calls.cancelled, 0);
  assert.equal(store.current()?.cancelled, false);
  assert.equal(store.calls.scanned, 0);
});

test("an existing paid row cannot become cancelled", async () => {
  const signed = request();
  const store = memory(openRow({ paidTx: TX }));
  const resolved = await resolveCancellation(
    {
      token: TOKEN,
      identity: identity(),
      lookup: { version: 2, request: signed, cancelled: false },
      signature: await merchantSignature(signed),
      nowSeconds: NOW,
    },
    store.deps,
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.record.paidTx, TX);
  assert.equal(resolved.record.cancelled, false);
  assert.equal(store.calls.cancelled, 0);
  assert.equal(resolved.notify, null);
});

test("an existing cancelled row keeps its cancelledAt", async () => {
  const signed = request();
  const store = memory(openRow({ cancelled: true, cancelledAt: "2020-01-01T00:00:00.000Z", cancelledAtSeconds: 1 }));
  const resolved = await resolveCancellation(
    {
      token: TOKEN,
      identity: identity(),
      lookup: { version: 2, request: signed, cancelled: false },
      signature: await merchantSignature(signed),
      nowSeconds: NOW,
    },
    store.deps,
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.record.cancelled, true);
  assert.equal(resolved.record.cancelledAt, "2020-01-01T00:00:00.000Z");
  assert.equal(store.calls.cancelled, 0);
});

test("wrong merchant signature is rejected without cancel", async () => {
  const signed = request();
  const store = memory(openRow());
  const bad = await signPaymentCancellation({ ...signed, merchant: OTHER }, MERCHANT_KEY).catch(() => null);
  // Sign as OTHER wallet against OTHER merchant field
  const otherReq = request({ merchant: OTHER, recipient: OTHER });
  // Use merchant key that is not OTHER — decideCancellation should fail
  const resolved = await resolveCancellation(
    {
      token: TOKEN,
      identity: identity(),
      lookup: { version: 2, request: signed, cancelled: false },
      signature: ("0x" + "11".repeat(65)) as Hex,
      nowSeconds: NOW,
    },
    store.deps,
  );
  assert.equal(resolved.ok, false);
  assert.equal(store.calls.cancelled, 0);
  assert.equal(store.calls.scanned, 0);
  void bad;
  void otherReq;
});

test("V1 cancel by payee address cancels without scan", async () => {
  const store = memory(openRow({ id: "legacy-v1" }));
  const resolved = await resolveCancellation(
    {
      token: TOKEN,
      identity: { version: 1, id: "legacy-v1", to: MERCHANT, amount: "0.2", memo: "note" },
      lookup: { version: 1, to: MERCHANT, amount: "0.2", memo: "note" },
      address: MERCHANT,
      nowSeconds: NOW,
    },
    store.deps,
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.record.cancelled, true);
  assert.equal(store.calls.scanned, 0);
});

test("V1 cancel by non-payee is rejected", async () => {
  const store = memory(openRow({ id: "legacy-v1" }));
  const resolved = await resolveCancellation(
    {
      token: TOKEN,
      identity: { version: 1, id: "legacy-v1", to: MERCHANT, amount: "0.2", memo: "note" },
      lookup: { version: 1, to: MERCHANT, amount: "0.2", memo: "note" },
      address: OTHER,
      nowSeconds: NOW,
    },
    store.deps,
  );
  assert.equal(resolved.ok, false);
  assert.equal(store.calls.cancelled, 0);
});

test("requestId mismatch cannot cancel", async () => {
  const signed = request({ requestId: REQUEST_B });
  const store = memory(openRow());
  const resolved = await resolveCancellation(
    {
      token: TOKEN,
      identity: { version: 2, id: REQUEST_B, to: MERCHANT, amount: "0.2", memo: "PAGED-RECON-TEST-1" },
      lookup: { version: 2, request: signed, cancelled: false },
      signature: await merchantSignature(signed),
      nowSeconds: NOW,
    },
    store.deps,
  );
  // Auth may pass for REQUEST_B signature, but markCancelled checks row.id === command.requestId
  assert.equal(resolved.ok, false);
  assert.equal(store.current()?.cancelled, false);
});
