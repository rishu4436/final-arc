import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex } from "viem";
import { ARC_CHAIN_ID } from "./arc";
import { signPaymentCancellation } from "./finalCancel";
import {
  nextCancelledRecord,
  nextPaidRecord,
  type CancelCommand,
  type PaidProof,
  type PayIdentity,
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

function proof(overrides: Partial<Extract<PaidProof, { version: 2 }>> = {}): PaidProof {
  return {
    version: 2,
    tx: TX,
    requestId: REQUEST_A,
    blockTimestamp: EXPIRES_AT - 50,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function memory(initial: PayRecord | null, find: CancellationDeps["findSettlementProof"]) {
  let row = initial;
  const calls = { paid: 0, cancelled: 0, scanned: 0 };
  const deps: CancellationDeps = {
    async getRecord(token) {
      return row && row.token === token ? row : null;
    },
    async markPaid(token, nextProof) {
      calls.paid += 1;
      if (!row || row.token !== token) return null;
      const next = nextPaidRecord(row, nextProof);
      if (!next) return null;
      row = next;
      return row;
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
    async findSettlementProof(lookup) {
      calls.scanned += 1;
      return find(lookup);
    },
    async ensureRecord() {
      if (!row) row = openRow();
      return row;
    },
  };
  return {
    deps,
    calls,
    current: () => row,
  };
}

async function merchantSignature(row: FinalRequest = request()): Promise<Hex> {
  return signPaymentCancellation(row, MERCHANT_KEY);
}

test("no settlement cancels a V2 request", async () => {
  const signed = request();
  const store = memory(openRow(), async () => null);
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
  assert.equal(resolved.notify, "cancelled");
  assert.equal(store.calls.paid, 0);
  assert.equal(store.calls.cancelled, 1);
  assert.equal(store.calls.scanned, 1);
});

test("an existing valid settlement is paid and not cancelled", async () => {
  const signed = request();
  const store = memory(openRow(), async () => proof());
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
  assert.equal(resolved.notify, "paid");
  assert.equal(store.calls.cancelled, 0);
  assert.equal(store.current()?.cancelledAt, null);
});

test("an in-time settlement found after expiry is paid, not cancelled", async () => {
  const signed = request();
  let sawCancelled: boolean | undefined;
  const store = memory(openRow(), async (lookup) => {
    sawCancelled = lookup.version === 2 ? lookup.cancelled : undefined;
    return proof({ blockTimestamp: EXPIRES_AT - 1 });
  });
  const resolved = await resolveCancellation(
    {
      token: TOKEN,
      identity: identity(),
      lookup: { version: 2, request: signed, cancelled: false },
      nowSeconds: EXPIRES_AT,
    },
    store.deps,
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.record.paidTx, TX);
  assert.equal(resolved.record.cancelled, false);
  assert.equal(store.calls.cancelled, 0);
  assert.equal(sawCancelled, false);
});

test("a settlement at or after expiry does not block cancellation", async () => {
  const signed = request();
  const store = memory(openRow(), async () => null);
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
  assert.equal(store.calls.paid, 0);
});

test("after the clock expires, a late settlement is not credited and cancel is not stored", async () => {
  const signed = request();
  const store = memory(openRow(), async () => null);
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
  assert.equal(store.calls.paid, 0);
  assert.equal(store.calls.cancelled, 0);
  assert.equal(store.current()?.cancelled, false);
  assert.equal(store.current()?.paidTx, null);
  assert.equal(store.calls.scanned, 1);
});

test("an existing paid row cannot become cancelled", async () => {
  const signed = request();
  const store = memory(openRow({ paidTx: TX }), async () => {
    throw new Error("paid row must not be scanned");
  });
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
  const store = memory(
    openRow({ cancelled: true, cancelledAt: "2020-01-01T00:00:00.000Z" }),
    async () => {
      throw new Error("cancelled row must not be scanned");
    },
  );
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
  assert.equal(resolved.record.paidTx, null);
  assert.equal(store.calls.paid, 0);
  assert.equal(store.calls.scanned, 0);
});

test("a rejected settlement does not block cancellation", async () => {
  const signed = request();
  const store = memory(openRow(), async () => null);
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
});

test("a different requestId does not block cancellation", async () => {
  const signed = request();
  const store = memory(openRow(), async (lookup) => {
    if (lookup.version === 2 && lookup.request.requestId === REQUEST_B) return proof({ requestId: REQUEST_B });
    return null;
  });
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
  assert.equal(store.calls.paid, 0);
});

test("a different amount, recipient, or memo does not block cancellation", async () => {
  const signed = request();
  const store = memory(openRow(), async (lookup) => {
    if (lookup.version !== 2) return null;
    const row = lookup.request;
    const same =
      row.amountBaseUnits === 1n &&
      row.recipient === OTHER &&
      row.memo === "other-memo";
    return same ? proof() : null;
  });
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
  assert.equal(store.calls.paid, 0);
});

test("V1 cancellation does not scan the chain", async () => {
  const store = memory(openRow({ id: "v1-link", to: OTHER }), async () => {
    throw new Error("V1 cancel must not scan");
  });
  const resolved = await resolveCancellation(
    {
      token: TOKEN,
      identity: { version: 1, id: "v1-link", to: OTHER, amount: "1", memo: "legacy" },
      lookup: { version: 1, to: OTHER, amount: "1", memo: "legacy" },
      address: OTHER,
      nowSeconds: NOW,
    },
    store.deps,
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.record.cancelled, true);
  assert.equal(resolved.record.paidTx, null);
  assert.equal(store.calls.scanned, 0);
  assert.equal(store.calls.paid, 0);
});

test("a failed V2 authorization does not scan", async () => {
  const signed = request();
  const store = memory(openRow(), async () => {
    throw new Error("unauthorized cancel must not scan");
  });
  const resolved = await resolveCancellation(
    {
      token: TOKEN,
      identity: identity(),
      lookup: { version: 2, request: signed, cancelled: false },
      signature: "0x" + "11".repeat(65),
      nowSeconds: NOW,
    },
    store.deps,
  );
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.equal(resolved.status, 403);
  assert.equal(store.calls.cancelled, 0);
  assert.equal(store.calls.scanned, 0);
});
