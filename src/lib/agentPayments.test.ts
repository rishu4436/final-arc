import assert from "node:assert/strict";
import { createFakeRedis } from "./fakeRedisRest";
import { redisPolicyLedger } from "./policyLedger";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createAgentPaymentIntent,
  getAgentPaymentIntent,
  getAgentPaymentResult,
  memoInstruction,
  submitAgentPaymentIntent,
  type AgentChainProof,
  type AgentIntentBody,
  type AgentPaymentsDeps,
  type AgentResult,
} from "./agentPayments";
import { ARC_CHAIN_ID, MEMO_ADDRESS, USDC_ADDRESS } from "./arc";
import { hashApiSecret, type ApiKeyRecord, type ApiKeyRuntime } from "./apiKeys";
import type { ApiScope } from "./apiScopes";
import type { ArcProofBody } from "./arcProof";
import { deriveMemoId, signFinalRequest, validateFinalRequest, type FinalRequestDraft } from "./finalRequest";
import { mergePayRecord, type PayRecord, type StoreFile } from "./payStore";

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const merchant = privateKeyToAccount(TEST_PRIVATE_KEY);
const other = privateKeyToAccount(OTHER_KEY);
const PEPPER = "agent-test-pepper";
const SECRET = "final_live_" + "a".repeat(43);
const SECRET_B = "final_live_" + "b".repeat(43);
const REQUEST_ID = ("0x" + "11".repeat(16)) as Hex;
const NONCE = ("0x" + "22".repeat(32)) as Hex;
const EXPIRES_AT = 2_000_000_000;
const NOW = 1_700_000_000;
const ORIGIN = "https://pay.example";
const TX = ("0x" + "ab".repeat(32)) as Hex;
const SENDER = "0x1111111111111111111111111111111111111111" as Address;

function keyRow(address: string, secret: string, scopes: readonly ApiScope[], id: string): ApiKeyRecord {
  return {
    id,
    merchant: address,
    name: id,
    prefix: secret.slice(0, "final_live_".length + 8),
    hash: hashApiSecret(secret, PEPPER),
    scopes: [...scopes],
    enabled: true,
    revoked: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
  };
}

function blankBlob(): StoreFile {
  return {
    records: {},
    webhooks: { endpoints: { wh: { id: "wh" } }, deliveries: { d: { id: "d" } } },
    apiKeys: { keys: { k: { hash: "kept" } } },
    escrows: { records: { e: { escrowId: "e" } } },
  };
}

type Harness = {
  deps: AgentPaymentsDeps;
  blob: StoreFile;
  keys: ApiKeyRecord[];
  events: { type: string }[];
  setNow: (value: number) => void;
  setVerify: (fn: (hash: string) => Promise<AgentChainProof>) => void;
  verifyCalls: () => number;
};

function harness(scopes: readonly ApiScope[] = ["agent:read", "agent:write"]): Harness {
  const blob = blankBlob();
  const keys = [keyRow(merchant.address, SECRET, scopes, "key_a")];
  const events: { type: string }[] = [];
  let clock = NOW;
  let calls = 0;
  let verifyImpl = async (hash: string): Promise<AgentChainProof> => ({
    result: { status: "NOT_FOUND", transactionHash: hash },
    blockTimestamp: null,
  });
  const apiKeyAuth: ApiKeyRuntime = {
    nowSeconds: () => clock,
    pepper: PEPPER,
    rateLimitPerMinute: 1_000_000,
    listKeys: async () => keys.map((row) => ({ ...row })),
    upsertKey: async (row) => {
      const index = keys.findIndex((item) => item.id === row.id);
      if (index >= 0) keys[index] = row;
      else keys.push(row);
    },
    createKey: async (row) => {
      const index = keys.findIndex((item) => item.id === row.id);
      if (index >= 0) keys[index] = row;
      else keys.push(row);
    },
    touchLastUsed: async () => undefined,
  };
  const deps: AgentPaymentsDeps = {
    nowSeconds: () => clock,
    origin: ORIGIN,
    authorization: null,
    apiKeyAuth,
    upsertRecord: async (record) => {
      const next = mergePayRecord(blob.records[record.token], record);
      blob.records[record.token] = next;
      return next;
    },
    createOwnedRecord: async (record) => {
      const existing = blob.records[record.token];
      if (existing) {
        const next = mergePayRecord(existing, record);
        blob.records[record.token] = next;
        return { record: next, created: false };
      }
      blob.records[record.token] = record;
      return { record, created: true };
    },
    listRecords: async () => Object.values(blob.records),
    loadReceipt: async () => ({ error: "Transaction not found on Arc mainnet.", status: 404 }),
    verify: async (hash) => {
      calls += 1;
      return verifyImpl(hash);
    },
    readBlob: async () => blob,
    mutateBlob: async (mutator) => {
      mutator(blob);
      return blob;
    },
    policyLedger: redisPolicyLedger({ url: "https://kv.fake", token: "t" }, createFakeRedis().fetch),
    emit: (input) => {
      events.push({ type: input.type });
    },
  };
  return {
    deps,
    blob,
    keys,
    events,
    setNow(value: number) {
      clock = value;
    },
    setVerify(fn) {
      verifyImpl = fn;
    },
    verifyCalls: () => calls,
  };
}

function draft(overrides: Partial<FinalRequestDraft> = {}): FinalRequestDraft {
  return {
    version: 2,
    requestId: REQUEST_ID,
    merchant: merchant.address,
    recipient: merchant.address,
    amountBaseUnits: 1_000_000n,
    memo: "INV-1042",
    chainId: ARC_CHAIN_ID,
    expiresAt: EXPIRES_AT,
    nonce: NONCE,
    ...overrides,
  };
}

async function signedBody(overrides: Partial<FinalRequestDraft> = {}, signer = merchant) {
  const fields = validateFinalRequest(draft(overrides));
  const signed = await signFinalRequest(fields, signer);
  return {
    requestId: signed.requestId,
    merchant: signed.merchant,
    recipient: signed.recipient,
    amountBaseUnits: signed.amountBaseUnits.toString(),
    memo: signed.memo,
    chainId: signed.chainId,
    expiresAt: signed.expiresAt,
    nonce: signed.nonce,
    signature: signed.signature,
    agentId: "desk-1",
    agentName: "invoice-bot",
    clientReference: "ref-9",
  };
}

function post(body: unknown, idempotency = "create-1", authorization: string | null = `Bearer ${SECRET}`): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "idempotency-key": idempotency };
  if (authorization) headers.authorization = authorization;
  return new Request("https://pay.example/api/v1/agent/payment-intents", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function submit(id: string, body: unknown, idempotency = "submit-1", authorization: string | null = `Bearer ${SECRET}`): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "idempotency-key": idempotency };
  if (authorization) headers.authorization = authorization;
  return new Request(`https://pay.example/api/v1/agent/payment-intents/${id}/submit`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function get(id: string, authorization: string | null = `Bearer ${SECRET}`): Request {
  const headers: Record<string, string> = {};
  if (authorization) headers.authorization = authorization;
  return new Request(`https://pay.example/api/v1/agent/payment-intents/${id}`, { headers });
}

function errorOf(result: AgentResult): { code: string; message: string } {
  assert.ok(!("intentId" in result.body));
  return result.body.error;
}

function intentOf(result: AgentResult): AgentIntentBody {
  assert.equal(result.status, 200);
  assert.ok("intentId" in result.body);
  return result.body;
}

function proof(over: Partial<ArcProofBody> = {}): ArcProofBody {
  const base: ArcProofBody = {
    status: "VERIFIED",
    transactionHash: TX,
    chain: "Arc",
    chainId: ARC_CHAIN_ID,
    transaction: {
      txHash: TX,
      chainId: ARC_CHAIN_ID,
      blockNumber: "10",
      blockHash: "0x" + "ef".repeat(32),
      from: SENDER,
      to: MEMO_ADDRESS,
      success: true,
    },
    memo: {
      contract: MEMO_ADDRESS,
      sender: SENDER,
      memoId: deriveMemoId(REQUEST_ID),
      memo: "INV-1042",
      valid: true,
    },
    settlement: {
      token: USDC_ADDRESS,
      from: SENDER,
      to: merchant.address,
      amount: "1",
      amountBaseUnits: "1000000",
      valid: true,
    },
    certificate: {
      height: 10,
      blockHash: "0x" + "ef".repeat(32),
      matchesTransaction: true,
      valid: true,
      signatureCount: 1,
      signaturesCryptographicallyVerified: false,
      note: "test certificate",
    },
    verification: {
      receiptValid: true,
      memoValid: true,
      settlementValid: true,
      certificateValid: true,
      verified: true,
    },
    boundToRequest: false,
    provesMerchantOwnership: false,
    provesPaid: false,
    note: "canonical proof",
  };
  return {
    ...base,
    ...over,
    transaction: { ...base.transaction, ...over.transaction },
    memo: { ...base.memo, ...over.memo },
    settlement: { ...base.settlement, ...over.settlement },
    certificate: { ...base.certificate, ...over.certificate },
    verification: { ...base.verification, ...over.verification },
  };
}

function verified(body: ArcProofBody, blockTimestamp: bigint = BigInt(NOW)): (hash: string) => Promise<AgentChainProof> {
  return async () => ({ result: body, blockTimestamp });
}

test("a signed create stores one intent wrapped around the V2 request", async () => {
  const h = harness();
  const body = await signedBody();
  const created = intentOf(await createAgentPaymentIntent(post(body), h.deps));
  assert.equal(created.status, "AWAITING_PAYMENT");
  assert.equal(created.intentId, body.requestId);
  assert.equal(created.merchant, merchant.address);
  assert.equal(created.recipient, merchant.address);
  assert.equal(created.amountBaseUnits, "1000000");
  assert.equal(created.token, USDC_ADDRESS);
  assert.equal(created.chainId, 5042);
  assert.equal(created.memoId, deriveMemoId(REQUEST_ID));
  assert.equal(created.agentId, "desk-1");
  assert.equal(created.instruction.executable, true);
  assert.equal(created.instruction.value, "0");
  assert.equal(created.instruction.to, MEMO_ADDRESS);
  assert.equal(created.instruction.memoContract, MEMO_ADDRESS);
  assert.equal(created.instruction.data.includes(body.memo), false);
  assert.ok(created.instruction.data.toLowerCase().includes(created.memoId.slice(2).toLowerCase()));
  assert.match(created.instruction.note, /Signature and broadcast are still required/);
  assert.equal(created.proofStatus, null);
  assert.equal(created.binding.boundToIntent, false);
  assert.equal(Object.values(h.blob.records).length, 1);
  assert.equal(Object.values(h.blob.records)[0]?.paidTx ?? null, null);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]?.type, "agent.payment_intent.created");
  const again = memoInstruction(
    validateFinalRequest(draft()),
    created.intentId,
    created.paymentUrl,
    true,
  );
  assert.equal(again.data, created.instruction.data);
});

test("an unsigned preview is not stored as a payable intent", async () => {
  const h = harness();
  const body = await signedBody();
  const unsigned = { ...body, signature: undefined };
  const result = await createAgentPaymentIntent(post(unsigned), h.deps);
  assert.equal(result.status, 400);
  assert.equal(errorOf(result).code, "not_executable");
  assert.equal(Object.keys(h.blob.agents?.intents ?? {}).length, 0);
  assert.equal(Object.keys(h.blob.records).length, 0);
  assert.equal(h.events.length, 0);
});

test("invalid amounts, addresses, chain, token, and expiry are rejected", async () => {
  const h = harness();
  const body = await signedBody();
  const zero = await createAgentPaymentIntent(post({ ...body, amountBaseUnits: "0" }, "z"), h.deps);
  assert.equal(zero.status, 400);
  assert.equal(errorOf(zero).code, "invalid_amount");
  const decimal = await createAgentPaymentIntent(post({ ...body, amountBaseUnits: "1.5" }, "d"), h.deps);
  assert.equal(decimal.status, 400);
  const badAddress = await createAgentPaymentIntent(post({ ...body, recipient: "nope" }, "a"), h.deps);
  assert.equal(badAddress.status, 400);
  assert.equal(errorOf(badAddress).code, "invalid_address");
  const wrongChain = await createAgentPaymentIntent(post({ ...body, chainId: 1 }, "c"), h.deps);
  assert.equal(wrongChain.status, 400);
  assert.equal(errorOf(wrongChain).code, "invalid_chain");
  const wrongToken = await createAgentPaymentIntent(
    post({ ...body, token: "0x1111111111111111111111111111111111111111" }, "t"),
    h.deps,
  );
  assert.equal(wrongToken.status, 400);
  const expiredBody = await signedBody({ expiresAt: NOW });
  const expired = await createAgentPaymentIntent(post(expiredBody, "e"), h.deps);
  assert.equal(expired.status, 400);
  assert.equal(errorOf(expired).code, "expired");
  assert.equal(Object.keys(h.blob.agents?.intents ?? {}).length, 0);
  assert.equal(Object.keys(h.blob.records).length, 0);
});

test("the caller cannot change merchant, recipient, amount, token, chain, or expiry after create", async () => {
  const h = harness();
  const body = await signedBody();
  const created = intentOf(await createAgentPaymentIntent(post(body), h.deps));
  const otherMerchant = await createAgentPaymentIntent(
    post(
      {
        ...body,
        requestId: "0x" + "ab".repeat(16),
        merchant: other.address,
        signature: "0x" + "11".repeat(65),
      },
      "m2",
    ),
    h.deps,
  );
  assert.equal(otherMerchant.status, 403);
  const otherRecipient = await createAgentPaymentIntent(
    post(
      {
        ...body,
        requestId: "0x" + "ac".repeat(16),
        recipient: other.address,
        signature: "0x" + "11".repeat(65),
      },
      "r2",
    ),
    h.deps,
  );
  assert.equal(otherRecipient.status, 400);
  assert.equal(errorOf(otherRecipient).code, "recipient_mismatch");
  const changedAmount = await signedBody({
    amountBaseUnits: 2n,
    nonce: ("0x" + "33".repeat(32)) as Hex,
  });
  const amount = await createAgentPaymentIntent(post({ ...changedAmount, requestId: body.requestId }, "amt"), h.deps);
  assert.equal(amount.status, 409);
  assert.equal(errorOf(amount).code, "immutable_terms");
  const changedExpiry = await signedBody({ expiresAt: EXPIRES_AT + 50 });
  const expiry = await createAgentPaymentIntent(post(changedExpiry, "exp"), h.deps);
  assert.equal(expiry.status, 409);
  const read = intentOf(await getAgentPaymentIntent(get(created.intentId), created.intentId, h.deps));
  assert.equal(read.amountBaseUnits, "1000000");
  assert.equal(read.expiresAt, EXPIRES_AT);
  assert.equal(read.recipient, merchant.address);
  assert.equal(read.merchant, merchant.address);
  const tamper = await submitAgentPaymentIntent(
    submit(created.intentId, { txHash: TX, amountBaseUnits: "1" }),
    created.intentId,
    h.deps,
  );
  assert.equal(tamper.status, 400);
  assert.equal(errorOf(tamper).code, "immutable_terms");
});

test("another merchant cannot read or submit the intent", async () => {
  const h = harness();
  h.keys.push(keyRow(other.address, SECRET_B, ["agent:read", "agent:write"], "key_b"));
  const created = intentOf(await createAgentPaymentIntent(post(await signedBody()), h.deps));
  const read = await getAgentPaymentIntent(get(created.intentId, `Bearer ${SECRET_B}`), created.intentId, h.deps);
  assert.equal(read.status, 404);
  const sent = await submitAgentPaymentIntent(
    submit(created.intentId, { txHash: TX }, "s", `Bearer ${SECRET_B}`),
    created.intentId,
    h.deps,
  );
  assert.equal(sent.status, 404);
  assert.equal(h.verifyCalls(), 0);
});

test("missing, revoked, disabled, expired, and read-only keys are rejected", async () => {
  const missing = harness();
  const noKey = await createAgentPaymentIntent(post(await signedBody(), "k", null), missing.deps);
  assert.equal(noKey.status, 401);
  const revoked = harness();
  revoked.keys[0]!.revoked = true;
  assert.equal((await createAgentPaymentIntent(post(await signedBody(), "r"), revoked.deps)).status, 401);
  const disabled = harness();
  disabled.keys[0]!.enabled = false;
  assert.equal((await createAgentPaymentIntent(post(await signedBody(), "d"), disabled.deps)).status, 401);
  const expired = harness();
  expired.keys[0]!.expiresAt = "2020-01-01T00:00:00.000Z";
  assert.equal((await createAgentPaymentIntent(post(await signedBody(), "e"), expired.deps)).status, 401);
  const readOnly = harness(["agent:read"]);
  const denied = await createAgentPaymentIntent(post(await signedBody(), "ro"), readOnly.deps);
  assert.equal(denied.status, 403);
  assert.equal(errorOf(denied).code, "forbidden");
});

test("a submitted hash is not verified until proof binds this intent", async () => {
  const h = harness();
  const created = intentOf(await createAgentPaymentIntent(post(await signedBody()), h.deps));
  const pending = intentOf(await submitAgentPaymentIntent(submit(created.intentId, { txHash: TX }), created.intentId, h.deps));
  assert.equal(pending.status, "SUBMITTED");
  assert.equal(pending.proofStatus, "NOT_FOUND");
  assert.equal(pending.verifiedTxHash, null);
  assert.equal(pending.binding.boundToIntent, false);
  assert.equal(Object.values(h.blob.records)[0]?.paidTx ?? null, null);
  assert.equal(h.events.some((event) => event.type === "agent.payment_intent.verified"), false);
  assert.equal(h.events.some((event) => event.type === "agent.payment_intent.submitted"), true);
});

test("wrong amount, recipient, memo, revert, and ambiguous settlement do not verify", async () => {
  const cases: { name: string; body: ArcProofBody; reason: string }[] = [
    {
      name: "amount",
      body: proof({ settlement: { ...proof().settlement, amountBaseUnits: "2", amount: "0.000002" } }),
      reason: "amount",
    },
    {
      name: "recipient",
      body: proof({ settlement: { ...proof().settlement, to: other.address } }),
      reason: "recipient",
    },
    {
      name: "memo",
      body: proof({ memo: { ...proof().memo, memoId: ("0x" + "44".repeat(32)) as Hex } }),
      reason: "memo",
    },
    {
      name: "reverted",
      body: proof({
        status: "INVALID",
        transaction: { ...proof().transaction, success: false },
        verification: { ...proof().verification, receiptValid: false, verified: false },
      }),
      reason: "reverted",
    },
    {
      name: "ambiguous",
      body: proof({
        status: "INVALID",
        settlement: {
          token: null,
          from: null,
          to: null,
          amount: null,
          amountBaseUnits: null,
          valid: false,
        },
        verification: { ...proof().verification, settlementValid: false, verified: false },
      }),
      reason: "settlement",
    },
  ];
  for (const item of cases) {
    const h = harness();
    const created = intentOf(await createAgentPaymentIntent(post(await signedBody(), item.name), h.deps));
    h.setVerify(verified(item.body));
    const result = intentOf(
      await submitAgentPaymentIntent(submit(created.intentId, { txHash: TX }, item.name), created.intentId, h.deps),
    );
    assert.equal(result.status, "FAILED", item.name);
    assert.notEqual(result.status, "VERIFIED");
    assert.equal(result.binding.boundToIntent, false);
    assert.equal(result.binding.reason, item.reason);
    assert.equal(result.proof?.provesPaid, false);
    assert.equal(result.proof?.boundToRequest, false);
    assert.equal(Object.values(h.blob.records)[0]?.paidTx ?? null, null);
  }
});

test("a matching proof verifies, and the same settlement cannot verify a second intent", async () => {
  const h = harness();
  const first = intentOf(await createAgentPaymentIntent(post(await signedBody(), "a"), h.deps));
  const secondBody = await signedBody({
    requestId: ("0x" + "55".repeat(16)) as Hex,
    nonce: ("0x" + "66".repeat(32)) as Hex,
    memo: "OTHER",
  });
  const second = intentOf(await createAgentPaymentIntent(post(secondBody, "b"), h.deps));
  h.setVerify(verified(proof()));
  const paid = intentOf(await submitAgentPaymentIntent(submit(first.intentId, { txHash: TX }, "ok"), first.intentId, h.deps));
  assert.equal(paid.status, "VERIFIED");
  assert.equal(paid.proofStatus, "VERIFIED");
  assert.equal(paid.binding.boundToIntent, true);
  assert.equal(paid.proof?.provesPaid, false);
  assert.equal(paid.proof?.provesMerchantOwnership, false);
  assert.equal(paid.proof?.boundToRequest, false);
  assert.equal(Object.values(h.blob.records).every((row) => row.paidTx == null), true);
  const stolen = await submitAgentPaymentIntent(submit(second.intentId, { txHash: TX }, "steal"), second.intentId, h.deps);
  assert.equal(stolen.status, 409);
  assert.equal(errorOf(stolen).code, "settlement_used");
  const still = intentOf(await getAgentPaymentIntent(get(second.intentId), second.intentId, h.deps));
  assert.equal(still.status, "AWAITING_PAYMENT");
});

test("expiry uses the block timestamp, not the caller clock", async () => {
  const h = harness();
  const created = intentOf(await createAgentPaymentIntent(post(await signedBody()), h.deps));
  h.setNow(EXPIRES_AT);
  const expired = intentOf(await getAgentPaymentIntent(get(created.intentId), created.intentId, h.deps));
  assert.equal(expired.status, "EXPIRED");
  assert.equal(expired.instruction.executable, false);
  h.setVerify(verified(proof(), BigInt(EXPIRES_AT - 1)));
  const inTime = intentOf(
    await submitAgentPaymentIntent(submit(created.intentId, { txHash: TX }, "in"), created.intentId, h.deps),
  );
  assert.equal(inTime.status, "VERIFIED");
  const lateHarness = harness();
  const lateIntent = intentOf(await createAgentPaymentIntent(post(await signedBody(), "late"), lateHarness.deps));
  lateHarness.setNow(EXPIRES_AT + 10);
  lateHarness.setVerify(verified(proof(), BigInt(EXPIRES_AT)));
  const late = intentOf(
    await submitAgentPaymentIntent(submit(lateIntent.intentId, { txHash: TX }, "late"), lateIntent.intentId, lateHarness.deps),
  );
  assert.equal(late.status, "FAILED");
  assert.equal(late.binding.reason, "expired");
});

test("the same idempotency key replays, and a different body conflicts", async () => {
  const h = harness();
  const body = await signedBody();
  const first = await createAgentPaymentIntent(post(body, "same"), h.deps);
  const second = await createAgentPaymentIntent(post(body, "same"), h.deps);
  assert.deepEqual(second, first);
  assert.equal(Object.keys(h.blob.agents?.intents ?? {}).length, 1);
  assert.equal(h.events.length, 1);
  const otherBody = await signedBody({
    requestId: ("0x" + "77".repeat(16)) as Hex,
    nonce: ("0x" + "88".repeat(32)) as Hex,
  });
  const conflict = await createAgentPaymentIntent(post(otherBody, "same"), h.deps);
  assert.equal(conflict.status, 409);
  assert.equal(errorOf(conflict).code, "idempotency_conflict");
  assert.equal(Object.keys(h.blob.agents?.intents ?? {}).length, 1);
});

test("idempotency keys do not collide across merchants", async () => {
  const h = harness();
  h.keys.push(keyRow(other.address, SECRET_B, ["agent:read", "agent:write"], "key_b"));
  const a = intentOf(await createAgentPaymentIntent(post(await signedBody(), "shared"), h.deps));
  const bBody = await signedBody(
    {
      requestId: ("0x" + "99".repeat(16)) as Hex,
      nonce: ("0x" + "aa".repeat(32)) as Hex,
      merchant: other.address,
      recipient: other.address,
    },
    other,
  );
  const b = intentOf(await createAgentPaymentIntent(post(bBody, "shared", `Bearer ${SECRET_B}`), h.deps));
  assert.notEqual(a.intentId, b.intentId);
  assert.equal(b.merchant, other.address);
});

test("partial and unavailable proofs are not verified, and a later retry can verify", async () => {
  const h = harness();
  const created = intentOf(await createAgentPaymentIntent(post(await signedBody()), h.deps));
  h.setVerify(async () => ({ result: { status: "UNAVAILABLE", transactionHash: TX }, blockTimestamp: null }));
  const down = intentOf(await submitAgentPaymentIntent(submit(created.intentId, { txHash: TX }, "once"), created.intentId, h.deps));
  assert.equal(down.proofStatus, "UNAVAILABLE");
  assert.equal(down.status, "SUBMITTED");
  h.setVerify(verified(proof({ status: "PARTIAL", verification: { ...proof().verification, verified: false, certificateValid: null } })));
  const partial = intentOf(
    await submitAgentPaymentIntent(submit(created.intentId, { txHash: TX }, "part"), created.intentId, h.deps),
  );
  assert.equal(partial.proofStatus, "PARTIAL");
  assert.equal(partial.status, "SUBMITTED");
  h.setVerify(verified(proof()));
  const done = intentOf(
    await submitAgentPaymentIntent(submit(created.intentId, { txHash: TX }, "once"), created.intentId, h.deps),
  );
  assert.equal(done.status, "VERIFIED");
});

test("webhooks follow stored transitions and a throwing emit does not roll state back", async () => {
  const h = harness();
  const created = intentOf(await createAgentPaymentIntent(post(await signedBody()), h.deps));
  const before = h.events.length;
  await getAgentPaymentIntent(get(created.intentId), created.intentId, h.deps);
  await getAgentPaymentResult(get(created.intentId), created.intentId, h.deps);
  assert.equal(h.events.length, before);
  h.deps.emit = () => {
    throw new Error("webhook down");
  };
  h.setVerify(verified(proof()));
  const paid = intentOf(await submitAgentPaymentIntent(submit(created.intentId, { txHash: TX }), created.intentId, h.deps));
  assert.equal(paid.status, "VERIFIED");
  const read = intentOf(await getAgentPaymentResult(get(created.intentId), created.intentId, h.deps));
  assert.equal(read.status, "VERIFIED");
  assert.equal(h.verifyCalls() > 0, true);
  const calls = h.verifyCalls();
  await getAgentPaymentResult(get(created.intentId), created.intentId, h.deps);
  assert.equal(h.verifyCalls(), calls);
});

test("intent writes keep payments, webhooks, api keys, and escrows", async () => {
  let canonical = blankBlob();
  canonical.records.existing = {
    token: "existing",
    id: "legacy",
    to: merchant.address,
    amount: "2",
    memo: "keep",
    createdAt: "2026-01-01T00:00:00.000Z",
    views: 3,
    lastViewedAt: null,
    cancelled: false,
    cancelledAt: null,
    paidTx: null,
    webhookUrl: null,
  } satisfies PayRecord;
  const h = harness();
  h.deps.readBlob = async () => structuredClone(canonical);
  h.deps.mutateBlob = async (mutator) => {
    const next = structuredClone(canonical);
    mutator(next);
    canonical = next;
    return next;
  };
  h.deps.upsertRecord = async (record) => {
    const next = mergePayRecord(canonical.records[record.token], record);
    canonical.records[record.token] = next;
    return next;
  };
  h.deps.createOwnedRecord = async (record) => {
    const existing = canonical.records[record.token];
    if (existing) {
      const next = mergePayRecord(existing, record);
      canonical.records[record.token] = next;
      return { record: next, created: false };
    }
    canonical.records[record.token] = record;
    return { record, created: true };
  };
  h.deps.listRecords = async () => Object.values(canonical.records);
  const created = intentOf(await createAgentPaymentIntent(post(await signedBody()), h.deps));
  assert.equal(created.status, "AWAITING_PAYMENT");
  assert.equal(canonical.records.existing?.memo, "keep");
  assert.equal(canonical.webhooks?.endpoints.wh && "id" in (canonical.webhooks.endpoints.wh as object), true);
  assert.equal((canonical.apiKeys?.keys.k as { hash: string }).hash, "kept");
  assert.equal((canonical.escrows?.records.e as { escrowId: string }).escrowId, "e");
  assert.ok(canonical.agents?.intents[created.intentId]);
  assert.equal(Object.keys(canonical.records).length, 2);
});

test("agent code does not import settlement writers or a signing key", () => {
  const files = [
    "src/lib/agentPayments.ts",
    "src/app/api/v1/agent/payment-intents/route.ts",
    "src/app/api/v1/agent/payment-intents/[id]/route.ts",
    "src/app/api/v1/agent/payment-intents/[id]/submit/route.ts",
    "src/app/api/v1/agent/payment-intents/[id]/result/route.ts",
  ];
  const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.equal(text.includes("reconcilePaymentRecord"), false);
  assert.equal(text.includes("markPaid"), false);
  assert.equal(text.includes("privateKey"), false);
  assert.equal(text.includes("walletClient"), false);
  assert.equal(text.includes("FINAL_ESCROW_ADDRESS"), false);
  assert.equal(text.includes("verifyArcTransaction"), true);
});
