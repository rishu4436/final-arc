import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashApiSecret, type ApiKeyRecord, type ApiKeyRuntime } from "./apiKeys";
import { API_SCOPES, DEFAULT_API_KEY_SCOPES, WALLET_ACTIONS, type ApiScope } from "./apiScopes";
import { signedWalletRequest, withMemoryNonces } from "./walletAuthTest";
import { ARC_CHAIN_ID, USDC_ADDRESS } from "./arc";
import { createAgentPaymentIntent, getAgentPaymentIntent, submitAgentPaymentIntent, type AgentPaymentsDeps } from "./agentPayments";
import type { ArcProofBody } from "./arcProof";
import { deriveMemoId, signFinalRequest, validateFinalRequest, type FinalRequestDraft } from "./finalRequest";
import { mergePayRecord, type StoreFile } from "./payStore";
import { createFakeRedis, type FakeRedis } from "./fakeRedisRest";
import { ledgerKey, livePolicyLedger, redisPolicyLedger, unavailablePolicyLedger } from "./policyLedger";
import {
  evaluatePaymentPolicy,
  mergePolicyRules,
  parsePolicyRules,
  type PaymentPolicy,
  type PolicySnapshot,
} from "./paymentPolicy";
import {
  createPolicy,
  deletePolicy,
  getPolicy,
  listPolicies,
  updatePolicy,
  verifiedSpendFromIntents,
  type PolicyDeps,
} from "./paymentPolicies";

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const merchant = privateKeyToAccount(TEST_PRIVATE_KEY);
const other = privateKeyToAccount(OTHER_KEY);
const PEPPER = "policy-test-pepper";
const SECRET = "final_live_" + "p".repeat(43);
const NOW = 1_700_000_000;
const EXPIRES_AT = 2_000_000_000;
const ORIGIN = "https://pay.example";
const REQUEST_ID = ("0x" + "11".repeat(16)) as Hex;
const NONCE = ("0x" + "22".repeat(32)) as Hex;
const TX = ("0x" + "ab".repeat(32)) as Hex;
const SENDER = "0x1111111111111111111111111111111111111111" as Address;

function keyRow(address: string, secret: string, scopes: readonly ApiScope[], id = "key_policy"): ApiKeyRecord {
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
    agents: { intents: {}, idempotency: {} },
    policies: { records: {}, reservations: {}, denials: {} },
  };
}

function policy(over: Partial<PaymentPolicy> = {}): PaymentPolicy {
  return {
    id: "pol_test",
    merchant: merchant.address,
    name: "desk",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    rules: { maxAmountBaseUnits: "1000000" },
    ...over,
    rules: { maxAmountBaseUnits: "1000000", ...over.rules },
  };
}

function putPolicy(blob: StoreFile, row: PaymentPolicy): void {
  blob.policies = blob.policies ?? { records: {}, reservations: {}, denials: {} };
  blob.policies.records[row.id] = row;
}

type Box = {
  redis: FakeRedis;
  blob: StoreFile;
  deps: AgentPaymentsDeps;
  policyDeps: PolicyDeps;
  keys: ApiKeyRecord[];
  events: { type: string; data?: Record<string, unknown> }[];
  setNow: (value: number) => void;
  setVerify: (fn: AgentPaymentsDeps["verify"]) => void;
};

function box(
  scopes: readonly ApiScope[] = ["agent:read", "agent:write", "policies:read", "policies:write"],
  shared?: { redis: FakeRedis; blob: StoreFile },
): Box {
  const blob = shared?.blob ?? blankBlob();
  const redis = shared?.redis ?? createFakeRedis();
  const keys = [keyRow(merchant.address, SECRET, scopes)];
  const events: Box["events"] = [];
  let clock = NOW;
  let verifyImpl: AgentPaymentsDeps["verify"] = async (hash) => ({
    result: { status: "NOT_FOUND", transactionHash: hash },
    blockTimestamp: null,
  });
  const apiKeyAuth: ApiKeyRuntime = withMemoryNonces({
    nowSeconds: () => clock,
    pepper: PEPPER,
    rateLimitPerMinute: 1_000_000,
    listKeys: async () => keys.map((row) => ({ ...row })),
    upsertKey: async () => undefined,
    createKey: async () => undefined,
    touchLastUsed: async () => undefined,
  });
  const emit = (input: { type: string; data?: Record<string, unknown> }) => {
    events.push(input);
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
    verify: async (hash) => verifyImpl(hash),
    readBlob: async () => blob,
    mutateBlob: async (mutator) => {
      mutator(blob);
      return blob;
    },
    policyLedger: redisPolicyLedger({ url: "https://kv.fake", token: "t" }, redis.fetch),
    processLock: false,
    emit: (input) => emit(input),
  };
  const policyDeps: PolicyDeps = {
    nowSeconds: () => clock,
    readBlob: async () => blob,
    mutateBlob: async (mutator) => {
      mutator(blob);
      return blob;
    },
    emit: (input) => emit(input),
    apiKeyAuth,
  };
  return {
    redis,
    blob,
    deps,
    policyDeps,
    keys,
    events,
    setNow(value: number) {
      clock = value;
    },
    setVerify(fn) {
      verifyImpl = fn;
    },
  };
}

function ledgerRows(h: Box, who: string = merchant.address): Record<string, { status: string; amountBaseUnits: string; consumedAt?: number | null; releaseReason?: string | null }> {
  const raw = h.redis.values.get(ledgerKey(who));
  return raw ? (JSON.parse(raw) as { reservations: Record<string, never> }).reservations : {};
}

function okProof(over: { success?: boolean; requestId?: Hex; amountBaseUnits?: string } = {}): ArcProofBody {
  const proof: ArcProofBody = {
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
      to: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
      success: true,
    },
    memo: {
      contract: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
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
      note: "test",
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
  };  proof.transaction.success = over.success ?? true;
  if (over.requestId) proof.memo.memoId = deriveMemoId(over.requestId);
  if (over.amountBaseUnits) proof.settlement.amountBaseUnits = over.amountBaseUnits;
  return proof;
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

async function signedBody(overrides: Partial<FinalRequestDraft> = {}, extra: Record<string, unknown> = {}) {
  const fields = validateFinalRequest(draft(overrides));
  const signed = await signFinalRequest(fields, merchant);
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
    ...extra,
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

function errorOf(body: unknown): { code: string; message: string; reasons?: { code: string }[] } {
  assert.ok(body && typeof body === "object" && "error" in body);
  return (body as { error: { code: string; message: string; reasons?: { code: string }[] } }).error;
}

async function walletHeaders(
  action: (typeof WALLET_ACTIONS)[keyof typeof WALLET_ACTIONS],
  account = merchant,
  url = "https://pay.example/api/v1/policies",
  method = "GET",
  body?: unknown,
) {
  const req = await signedWalletRequest({
    account,
    action,
    url,
    method,
    body,
    timestamp: NOW,
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

test("evaluatePaymentPolicy is deterministic and has no side effects", () => {
  const spend = [{ amountBaseUnits: "1000000", verifiedAt: NOW - 10 }];
  const input = {
    merchant: merchant.address.toLowerCase(),
    agentId: "desk-1",
    recipient: merchant.address.toLowerCase(),
    token: USDC_ADDRESS.toLowerCase(),
    chainId: ARC_CHAIN_ID,
    amountBaseUnits: "1000000",
    now: NOW,
    policies: [policy()],
    verifiedSpend: spend,
  };
  const first = evaluatePaymentPolicy(input);
  const second = evaluatePaymentPolicy(input);
  assert.deepEqual(first, second);
  assert.equal(first.allowed, true);
  assert.equal(first.policyVersion, 1);
  assert.deepEqual(spend, [{ amountBaseUnits: "1000000", verifiedAt: NOW - 10 }]);
});

test("amount at the cap passes and one unit over fails", () => {
  const base = {
    merchant: merchant.address,
    agentId: "desk-1",
    recipient: merchant.address,
    token: USDC_ADDRESS,
    chainId: ARC_CHAIN_ID,
    now: NOW,
    policies: [policy({ rules: { maxAmountBaseUnits: "1000000" } })],
    verifiedSpend: [],
  };
  assert.equal(evaluatePaymentPolicy({ ...base, amountBaseUnits: "1000000" }).allowed, true);
  const over = evaluatePaymentPolicy({ ...base, amountBaseUnits: "1000001" });
  assert.equal(over.allowed, false);
  assert.equal(over.reasons[0]?.code, "AMOUNT_LIMIT_EXCEEDED");
  assert.equal(evaluatePaymentPolicy({ ...base, amountBaseUnits: "999999" }).allowed, true);
});

test("zero max amount denies every positive payment", () => {
  const decision = evaluatePaymentPolicy({
    merchant: merchant.address,
    agentId: null,
    recipient: merchant.address,
    token: USDC_ADDRESS,
    chainId: ARC_CHAIN_ID,
    amountBaseUnits: "1",
    now: NOW,
    policies: [policy({ rules: { maxAmountBaseUnits: "0" } })],
    verifiedSpend: [],
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasons[0]?.code, "AMOUNT_LIMIT_EXCEEDED");
});

test("spend window includes only verifiedAt in (now - window, now]", () => {
  const rules = { maxSpendBaseUnits: "1000000", windowSeconds: 100 };
  const call = (verifiedAt: number, amount = "1") =>
    evaluatePaymentPolicy({
      merchant: merchant.address,
      agentId: null,
      recipient: merchant.address,
      token: USDC_ADDRESS,
      chainId: ARC_CHAIN_ID,
      amountBaseUnits: amount,
      now: NOW,
      policies: [policy({ rules })],
      verifiedSpend: [{ amountBaseUnits: "1000000", verifiedAt }],
    });
  assert.equal(call(NOW - 100).allowed, true);
  assert.equal(call(NOW - 99).allowed, false);
  assert.equal(call(NOW).allowed, false);
  assert.equal(call(NOW + 1).allowed, true);
  const exact = evaluatePaymentPolicy({
    merchant: merchant.address,
    agentId: null,
    recipient: merchant.address,
    token: USDC_ADDRESS,
    chainId: ARC_CHAIN_ID,
    amountBaseUnits: "1",
    now: NOW,
    policies: [policy({ rules })],
    verifiedSpend: [{ amountBaseUnits: "1000000", verifiedAt: NOW - 10 }],
  });
  assert.equal(exact.reasons[0]?.code, "WINDOW_SPEND_LIMIT_EXCEEDED");
  const room = evaluatePaymentPolicy({
    merchant: merchant.address,
    agentId: null,
    recipient: merchant.address,
    token: USDC_ADDRESS,
    chainId: ARC_CHAIN_ID,
    amountBaseUnits: "1000000",
    now: NOW,
    policies: [policy({ rules: { maxSpendBaseUnits: "2000000", windowSeconds: 100 } })],
    verifiedSpend: [{ amountBaseUnits: "1000000", verifiedAt: NOW - 10 }],
  });
  assert.equal(room.allowed, true);
});

test("one denying policy denies even if another allows", () => {
  const decision = evaluatePaymentPolicy({
    merchant: merchant.address,
    agentId: "desk-1",
    recipient: merchant.address,
    token: USDC_ADDRESS,
    chainId: ARC_CHAIN_ID,
    amountBaseUnits: "2000000",
    now: NOW,
    policies: [
      policy({ id: "pol_wide", rules: { maxAmountBaseUnits: "9000000" } }),
      policy({ id: "pol_tight", rules: { maxAmountBaseUnits: "1000000" } }),
    ],
    verifiedSpend: [],
  });
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.policyIds, ["pol_tight", "pol_wide"]);
  assert.equal(decision.reasons.some((item) => item.policyId === "pol_tight"), true);
});

test("disabled policies do not participate and zero enabled policies allow", () => {
  const disabled = evaluatePaymentPolicy({
    merchant: merchant.address,
    agentId: null,
    recipient: merchant.address,
    token: USDC_ADDRESS,
    chainId: ARC_CHAIN_ID,
    amountBaseUnits: "999999999",
    now: NOW,
    policies: [policy({ enabled: false, rules: { maxAmountBaseUnits: "1" } })],
    verifiedSpend: [],
  });
  assert.equal(disabled.allowed, true);
  assert.deepEqual(disabled.policyIds, []);
  const none = evaluatePaymentPolicy({
    merchant: merchant.address,
    agentId: null,
    recipient: merchant.address,
    token: USDC_ADDRESS,
    chainId: ARC_CHAIN_ID,
    amountBaseUnits: "1",
    now: NOW,
    policies: [],
    verifiedSpend: [],
  });
  assert.equal(none.allowed, true);
});

test("allowlists are exact and empty lists deny", () => {
  const base = {
    merchant: merchant.address,
    recipient: merchant.address,
    token: USDC_ADDRESS,
    chainId: ARC_CHAIN_ID,
    amountBaseUnits: "1",
    now: NOW,
    verifiedSpend: [],
  };
  const agents = evaluatePaymentPolicy({
    ...base,
    agentId: "desk",
    policies: [policy({ rules: { allowedAgentIds: ["Desk"] } })],
  });
  assert.equal(agents.reasons[0]?.code, "AGENT_NOT_ALLOWED");
  const named = evaluatePaymentPolicy({
    ...base,
    agentId: "other",
    policies: [policy({ rules: { allowedAgentIds: ["real"] } })],
  });
  assert.equal(named.allowed, false);
  const match = evaluatePaymentPolicy({
    ...base,
    agentId: "Desk",
    policies: [policy({ rules: { allowedAgentIds: ["Desk"] } })],
  });
  assert.equal(match.allowed, true);
  const empty = evaluatePaymentPolicy({
    ...base,
    agentId: "Desk",
    policies: [policy({ rules: { allowedAgentIds: [] } })],
  });
  assert.equal(empty.reasons[0]?.code, "AGENT_NOT_ALLOWED");
  const wrongRecipient = evaluatePaymentPolicy({
    ...base,
    agentId: null,
    recipient: other.address,
    policies: [policy({ rules: { allowedRecipients: [merchant.address.toLowerCase()] } })],
  });
  assert.equal(wrongRecipient.reasons[0]?.code, "RECIPIENT_NOT_ALLOWED");
  const checksum = evaluatePaymentPolicy({
    ...base,
    agentId: null,
    recipient: merchant.address.toLowerCase(),
    policies: [policy({ rules: { allowedRecipients: [merchant.address.toLowerCase()] } })],
  });
  assert.equal(checksum.allowed, true);
  const token = evaluatePaymentPolicy({
    ...base,
    agentId: null,
    policies: [policy({ rules: { allowedTokens: [] } })],
  });
  assert.equal(token.reasons[0]?.code, "TOKEN_NOT_ALLOWED");
  const chain = evaluatePaymentPolicy({
    ...base,
    agentId: null,
    chainId: 1,
    policies: [policy({ rules: { allowedChainIds: [ARC_CHAIN_ID] } })],
  });
  assert.equal(chain.reasons[0]?.code, "CHAIN_NOT_ALLOWED");
});

test("policy documents reject malformed rules", () => {
  assert.equal("error" in parsePolicyRules({}), true);
  assert.equal("error" in parsePolicyRules({ maxAmountBaseUnits: "1.5" }), true);
  assert.equal("error" in parsePolicyRules({ maxAmountBaseUnits: "-1" }), true);
  assert.equal("error" in parsePolicyRules({ maxAmountBaseUnits: "1e6" }), true);
  assert.equal("error" in parsePolicyRules({ maxSpendBaseUnits: "1" }), true);
  assert.equal("error" in parsePolicyRules({ maxSpendBaseUnits: "1", windowSeconds: 0 }), true);
  assert.equal("error" in parsePolicyRules({ maxSpendBaseUnits: "1", windowSeconds: -5 }), true);
  assert.equal("error" in parsePolicyRules({ allowedChainIds: [1] }), true);
  assert.equal("error" in parsePolicyRules({ allowedChainIds: [ARC_CHAIN_ID, ARC_CHAIN_ID] }), true);
  assert.equal("error" in parsePolicyRules({ allowedTokens: [other.address] }), true);
  assert.equal("error" in parsePolicyRules({ allowedRecipients: [merchant.address, merchant.address.toLowerCase()] }), true);
  assert.equal("error" in parsePolicyRules({ allowedAgentIds: ["Desk", "Desk"] }), true);
  assert.equal("error" in parsePolicyRules({ nope: "1" }), true);
  const ok = parsePolicyRules({ maxAmountBaseUnits: "0" });
  assert.equal("error" in ok, false);
  const merged = mergePolicyRules(
    { maxAmountBaseUnits: "5", allowedAgentIds: ["desk-1"], maxSpendBaseUnits: "9", windowSeconds: 10 },
    { maxAmountBaseUnits: "7" },
  );
  assert.equal("error" in merged, false);
  if ("error" in merged) return;
  assert.equal(merged.maxAmountBaseUnits, "7");
  assert.deepEqual(merged.allowedAgentIds, ["desk-1"]);
  assert.equal(merged.maxSpendBaseUnits, "9");
  const cleared = mergePolicyRules(merged, { allowedAgentIds: null });
  assert.equal("error" in cleared, false);
  if ("error" in cleared) return;
  assert.equal(cleared.allowedAgentIds, undefined);
  assert.equal(cleared.maxAmountBaseUnits, "7");
});

test("default scopes omit policy scopes", () => {
  assert.equal(DEFAULT_API_KEY_SCOPES.includes("policies:read"), false);
  assert.equal(DEFAULT_API_KEY_SCOPES.includes("policies:write"), false);
  assert.equal(API_SCOPES.includes("policies:read"), true);
  assert.equal(API_SCOPES.includes("policies:write"), true);
});

test("wallet can create a policy and an agent key cannot", async () => {
  const h = box(["agent:write"]);
  const createBody = { name: "ops", rules: { maxAmountBaseUnits: "1000000" } };
  const headers = await walletHeaders(
    WALLET_ACTIONS.policiesCreate,
    merchant,
    "https://pay.example/api/v1/policies",
    "POST",
    createBody,
  );
  const created = await createPolicy(
    new Request("https://pay.example/api/v1/policies", {
      method: "POST",
      headers,
      body: JSON.stringify(createBody),
    }),
    h.policyDeps,
  );
  assert.equal(created.status, 200);
  const id = (created.body as { policy: PaymentPolicy }).policy.id;
  assert.equal((created.body as { policy: PaymentPolicy }).policy.version, 1);
  assert.equal((created.body as { policy: PaymentPolicy }).policy.merchant, merchant.address);
  const agentAttempt = await createPolicy(
    new Request("https://pay.example/api/v1/policies", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "self", rules: { maxAmountBaseUnits: "999" } }),
    }),
    h.policyDeps,
  );
  assert.equal(agentAttempt.status, 403);
  assert.equal(errorOf(agentAttempt.body).code, "forbidden");
  const listed = await listPolicies(
    new Request("https://pay.example/api/v1/policies", { headers: await walletHeaders(WALLET_ACTIONS.policiesList) }),
    h.policyDeps,
  );
  assert.equal(listed.status, 200);
  assert.equal((listed.body as { policies: PaymentPolicy[] }).policies.length, 1);
  const foreign = await getPolicy(
    new Request(`https://pay.example/api/v1/policies/${id}`, {
      headers: await walletHeaders(
        WALLET_ACTIONS.policiesGet,
        other,
        `https://pay.example/api/v1/policies/${id}`,
        "GET",
      ),
    }),
    id,
    h.policyDeps,
  );
  assert.equal(foreign.status, 404);
});

test("policy writes require policies:write and reject revoked keys and smuggled credentials", async () => {
  const h = box(["policies:read"]);
  putPolicy(h.blob, policy());
  const read = await getPolicy(
    new Request("https://pay.example/api/v1/policies/pol_test", { headers: { authorization: `Bearer ${SECRET}` } }),
    "pol_test",
    h.policyDeps,
  );
  assert.equal(read.status, 200);
  const patch = await updatePolicy(
    new Request("https://pay.example/api/v1/policies/pol_test", {
      method: "PATCH",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ rules: { maxAmountBaseUnits: "2" } }),
    }),
    "pol_test",
    h.policyDeps,
  );
  assert.equal(patch.status, 403);
  assert.equal((h.blob.policies?.records.pol_test as PaymentPolicy).rules.maxAmountBaseUnits, "1000000");
  h.keys[0] = keyRow(merchant.address, SECRET, ["policies:write"], "key_policy");
  h.keys[0].revoked = true;
  const revoked = await deletePolicy(
    new Request("https://pay.example/api/v1/policies/pol_test", {
      method: "DELETE",
      headers: { authorization: `Bearer ${SECRET}` },
    }),
    "pol_test",
    h.policyDeps,
  );
  assert.equal(revoked.status, 401);
  h.keys[0].revoked = false;
  const query = await createPolicy(
    new Request("https://pay.example/api/v1/policies?api_key=final_live_nope", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "x", rules: { maxAmountBaseUnits: "1" } }),
    }),
    h.policyDeps,
  );
  assert.equal(query.status, 401);
  const bodyKey = await createPolicy(
    new Request("https://pay.example/api/v1/policies", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "x", rules: { maxAmountBaseUnits: "1" }, apiKey: SECRET }),
    }),
    h.policyDeps,
  );
  assert.equal(bodyKey.status, 400);
});

test("PATCH does not wipe omitted rules into allow-all", async () => {
  const h = box(["policies:write"]);
  putPolicy(
    h.blob,
    policy({
      rules: { maxAmountBaseUnits: "5", allowedAgentIds: ["desk-1"], maxSpendBaseUnits: "9", windowSeconds: 50 },
    }),
  );
  const updated = await updatePolicy(
    new Request("https://pay.example/api/v1/policies/pol_test", {
      method: "PATCH",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ rules: { maxAmountBaseUnits: "8" } }),
    }),
    "pol_test",
    h.policyDeps,
  );
  assert.equal(updated.status, 200);
  const rules = (updated.body as { policy: PaymentPolicy }).policy.rules;
  assert.equal(rules.maxAmountBaseUnits, "8");
  assert.deepEqual(rules.allowedAgentIds, ["desk-1"]);
  assert.equal(rules.maxSpendBaseUnits, "9");
  assert.equal(rules.windowSeconds, 50);
});

test("a policy denial stores no V2 request and an agent cannot bypass the cap", async () => {
  const h = box();
  putPolicy(h.blob, policy({ rules: { maxAmountBaseUnits: "1000000" } }));
  const over = await createAgentPaymentIntent(
    post(await signedBody({ amountBaseUnits: 1_000_001n }), "over"),
    h.deps,
  );
  assert.equal(over.status, 403);
  assert.equal(errorOf(over.body).code, "policy_denied");
  assert.equal(errorOf(over.body).reasons?.[0]?.code, "AMOUNT_LIMIT_EXCEEDED");
  assert.equal(Object.keys(h.blob.records).length, 0);
  assert.equal(Object.keys(h.blob.agents?.intents ?? {}).length, 0);
  assert.equal(h.events.some((event) => event.type === "agent.payment_intent.policy_denied"), true);
  assert.equal(h.events.some((event) => event.type === "payment.paid"), false);
  assert.equal(h.events.some((event) => event.type === "agent.payment_intent.created"), false);
  const at = await createAgentPaymentIntent(post(await signedBody({ amountBaseUnits: 1_000_000n }), "at"), h.deps);
  assert.equal(at.status, 200);
  assert.equal(Object.keys(h.blob.records).length, 1);
  const intent = at.body as { policy: PolicySnapshot | null; amountBaseUnits: string };
  assert.equal(intent.policy?.decision, "allowed");
  assert.equal(intent.policy?.limits[0]?.maxAmountBaseUnits, "1000000");
  const prior = (h.blob.policies?.records.pol_test as PaymentPolicy).rules.maxAmountBaseUnits;
  (h.blob.policies?.records.pol_test as PaymentPolicy).rules.maxAmountBaseUnits = "1";
  const read = await getAgentPaymentIntent(
    new Request(`https://pay.example/api/v1/agent/payment-intents/${REQUEST_ID}`, {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
    REQUEST_ID,
    h.deps,
  );
  assert.equal(read.status, 200);
  assert.equal((read.body as { policy: PolicySnapshot }).policy.limits[0]?.maxAmountBaseUnits, "1000000");
  assert.equal((read.body as { amountBaseUnits: string }).amountBaseUnits, "1000000");
  assert.notEqual(prior, "1");
});

test("unsigned requests stay non-executable and denial idempotency does not duplicate", async () => {
  const h = box();
  putPolicy(h.blob, policy({ rules: { maxAmountBaseUnits: "5000000", maxSpendBaseUnits: "5000000", windowSeconds: 100 } }));
  const unsigned = await signedBody();
  delete (unsigned as { signature?: string }).signature;
  const preview = await createAgentPaymentIntent(post(unsigned, "unsigned"), h.deps);
  assert.equal(preview.status, 400);
  assert.equal(errorOf(preview.body).code, "not_executable");
  assert.equal(Object.keys(h.blob.records).length, 0);
  assert.equal(Object.keys(ledgerRows(h)).length, 0);
  const first = await createAgentPaymentIntent(post(await signedBody({ amountBaseUnits: 9_000_000n }), "same"), h.deps);
  assert.equal(first.status, 403);
  const again = await createAgentPaymentIntent(post(await signedBody({ amountBaseUnits: 9_000_000n }), "same"), h.deps);
  assert.equal(again.status, 403);
  assert.equal(Object.keys(h.blob.policies?.denials ?? {}).length, 1);
  const conflict = await createAgentPaymentIntent(post(await signedBody({ amountBaseUnits: 8_000_000n }), "same"), h.deps);
  assert.equal(conflict.status, 409);
  assert.equal(errorOf(conflict.body).code, "idempotency_conflict");
});

test("a throwing denial webhook does not roll back the audit row", async () => {
  const h = box();
  putPolicy(h.blob, policy({ rules: { maxAmountBaseUnits: "1" } }));
  h.deps.emit = () => {
    throw new Error("hook down");
  };
  const denied = await createAgentPaymentIntent(post(await signedBody(), "hook"), h.deps);
  assert.equal(denied.status, 403);
  assert.equal(Object.keys(h.blob.policies?.denials ?? {}).length, 1);
  assert.equal(Object.keys(h.blob.records).length, 0);
});

test("reservations count and submitted or failed rows do not count as verified spend", async () => {
  const h = box();
  putPolicy(h.blob, policy({ rules: { maxSpendBaseUnits: "2000000", windowSeconds: 86_400 } }));
  const first = await createAgentPaymentIntent(post(await signedBody({ amountBaseUnits: 1_000_000n }), "a"), h.deps);
  assert.equal(first.status, 200);
  const submitted = await submitAgentPaymentIntent(
    new Request(`https://pay.example/api/v1/agent/payment-intents/${REQUEST_ID}/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", "idempotency-key": "sub" },
      body: JSON.stringify({ txHash: TX }),
    }),
    REQUEST_ID,
    h.deps,
  );
  assert.equal((submitted.body as { status: string }).status, "SUBMITTED");
  assert.equal(verifiedSpendFromIntents(h.blob, merchant.address).length, 0);
  const secondId = ("0x" + "33".repeat(16)) as Hex;
  const secondNonce = ("0x" + "44".repeat(32)) as Hex;
  const second = await createAgentPaymentIntent(
    post(await signedBody({ requestId: secondId, nonce: secondNonce, amountBaseUnits: 1_000_000n }), "b"),
    h.deps,
  );
  assert.equal(second.status, 200);
  const thirdId = ("0x" + "55".repeat(16)) as Hex;
  const thirdNonce = ("0x" + "66".repeat(32)) as Hex;
  const third = await createAgentPaymentIntent(
    post(await signedBody({ requestId: thirdId, nonce: thirdNonce, amountBaseUnits: 1n }), "c"),
    h.deps,
  );
  assert.equal(third.status, 403);
  assert.equal(errorOf(third.body).reasons?.[0]?.code, "WINDOW_SPEND_LIMIT_EXCEEDED");
  assert.equal(Object.keys(h.blob.records).length, 2);
});

test("verified spend outside the window does not block a new payment", async () => {
  const h = box();
  putPolicy(h.blob, policy({ rules: { maxSpendBaseUnits: "1000000", windowSeconds: 100 } }));
  h.blob.agents = {
    intents: {
      old: {
        status: "VERIFIED",
        merchant: merchant.address,
        verifiedAt: NOW - 100,
        amountBaseUnits: "1000000",
        intentId: "old",
        requestId: "old",
        createdAt: "2020-01-01T00:00:00.000Z",
      },
    },
    idempotency: {},
  };
  const created = await createAgentPaymentIntent(post(await signedBody({ amountBaseUnits: 1_000_000n }), "fresh"), h.deps);
  assert.equal(created.status, 200);
});

test("concurrent creates cannot both pass a one-payment spend cap", async () => {
  const h = box();
  putPolicy(h.blob, policy({ rules: { maxSpendBaseUnits: "1000000", windowSeconds: 86_400 } }));
  const firstBody = await signedBody({ amountBaseUnits: 1_000_000n });
  const secondBody = await signedBody({
    requestId: ("0x" + "77".repeat(16)) as Hex,
    nonce: ("0x" + "88".repeat(32)) as Hex,
    amountBaseUnits: 1_000_000n,
  });
  const [left, right] = await Promise.all([
    createAgentPaymentIntent(post(firstBody, "left"), h.deps),
    createAgentPaymentIntent(post(secondBody, "right"), h.deps),
  ]);
  const statuses = [left.status, right.status].sort();
  assert.deepEqual(statuses, [200, 403]);
  assert.equal(Object.keys(h.blob.records).length, 1);
  const reserved = Object.values(ledgerRows(h)).filter((row) => row.status === "RESERVED");
  assert.equal(reserved.length, 1);
});

test("verification sets verifiedAt and does not mark the payment row paid", async () => {
  const h = box();
  putPolicy(h.blob, policy({ rules: { maxAmountBaseUnits: "1000000" } }));
  const created = await createAgentPaymentIntent(post(await signedBody(), "pay"), h.deps);
  assert.equal(created.status, 200);
  const proof = okProof();

  h.setVerify(async () => ({ result: proof, blockTimestamp: BigInt(NOW) }));
  h.setNow(NOW + 25);
  const paid = await submitAgentPaymentIntent(
    new Request(`https://pay.example/api/v1/agent/payment-intents/${REQUEST_ID}/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", "idempotency-key": "ok" },
      body: JSON.stringify({ txHash: TX }),
    }),
    REQUEST_ID,
    h.deps,
  );
  assert.equal((paid.body as { status: string }).status, "VERIFIED");
  assert.equal((paid.body as { verifiedAt: number }).verifiedAt, NOW + 25);
  assert.equal(Object.values(h.blob.records)[0]?.paidTx ?? null, null);
  assert.equal(ledgerRows(h)[REQUEST_ID.toLowerCase()], undefined);
});

test("expiry releases a reservation and failed verification releases it", async () => {
  const h = box();
  putPolicy(h.blob, policy({ rules: { maxSpendBaseUnits: "5000000", windowSeconds: 86_400 } }));
  await createAgentPaymentIntent(post(await signedBody(), "hold"), h.deps);
  assert.equal(ledgerRows(h)[REQUEST_ID.toLowerCase()]?.status, "RESERVED");
  h.setNow(EXPIRES_AT + 3600);
  await getAgentPaymentIntent(
    new Request(`https://pay.example/api/v1/agent/payment-intents/${REQUEST_ID}`, {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
    REQUEST_ID,
    h.deps,
  );
  assert.equal(ledgerRows(h)[REQUEST_ID.toLowerCase()]?.status, "RELEASED");
});

test("zero enabled policies keep the Phase 10 create path", async () => {
  const h = box();
  const created = await createAgentPaymentIntent(post(await signedBody(), "plain"), h.deps);
  assert.equal(created.status, 200);
  assert.equal((created.body as { policy: unknown }).policy, null);
  assert.equal((h.blob.webhooks?.endpoints.wh as { id: string }).id, "wh");
  assert.equal((h.blob.apiKeys?.keys.k as { hash: string }).hash, "kept");
  assert.equal((h.blob.escrows?.records.e as { escrowId: string }).escrowId, "e");
});

test("policy and checkout modules do not reconcile, mark paid, or hold a key", () => {
  const files = [
    "src/lib/paymentPolicy.ts",
    "src/lib/paymentPolicies.ts",
    "src/app/api/v1/policies/route.ts",
    "src/app/api/v1/policies/[id]/route.ts",
    "src/components/dashboard/PoliciesPanel.tsx",
  ];
  const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.equal(text.includes("reconcilePaymentRecord"), false);
  assert.equal(text.includes("markPaid"), false);
  assert.equal(text.includes("privateKey"), false);
  assert.equal(text.includes("walletClient"), false);
  const isolated = [
    "src/lib/checkoutObserve.ts",
    "src/app/api/pay/observe/route.ts",
    "src/app/p/[token]/page.tsx",
    "src/app/api/v1/payment-requests/route.ts",
  ];
  for (const file of isolated) {
    const source = readFileSync(file, "utf8");
    assert.equal(source.includes("evaluatePaymentPolicy"), false, file);
    assert.equal(source.includes("paymentPolicies"), false, file);
  }
});

test("delete removes only that policy", async () => {
  const h = box(["policies:write"]);
  putPolicy(h.blob, policy({ id: "pol_a" }));
  putPolicy(h.blob, policy({ id: "pol_b", rules: { maxAmountBaseUnits: "2" } }));
  const removed = await deletePolicy(
    new Request("https://pay.example/api/v1/policies/pol_a", {
      method: "DELETE",
      headers: { authorization: `Bearer ${SECRET}` },
    }),
    "pol_a",
    h.policyDeps,
  );
  assert.equal(removed.status, 200);
  assert.equal(h.blob.policies?.records.pol_a, undefined);
  assert.ok(h.blob.policies?.records.pol_b);
  assert.equal((h.blob.apiKeys?.keys.k as { hash: string }).hash, "kept");
});

// ---------------- Phase 11.1: atomic cross-instance reservation ----------------

const USDC = 1_000_000n;
function rid(n: number): Hex {
  return ("0x" + n.toString(16).padStart(2, "0").repeat(16)) as Hex;
}
function nonce(n: number): Hex {
  return ("0x" + n.toString(16).padStart(2, "0").repeat(32)) as Hex;
}
async function bodyFor(n: number, amount: bigint) {
  return signedBody({ requestId: rid(n), nonce: nonce(n), amountBaseUnits: amount });
}
function seedVerified(blob: StoreFile, amount: bigint, id = "seed", at = NOW - 10): void {
  blob.agents = blob.agents ?? { intents: {}, idempotency: {} };
  blob.agents.intents[id] = {
    intentId: id,
    requestId: id,
    status: "VERIFIED",
    merchant: merchant.address,
    verifiedAt: at,
    amountBaseUnits: amount.toString(),
    createdAt: "2020-01-01T00:00:00.000Z",
  };
}
function capPolicy(cap: bigint, id = "pol_cap"): PaymentPolicy {
  return policy({ id, rules: { maxAmountBaseUnits: (100n * USDC).toString(), maxSpendBaseUnits: cap.toString(), windowSeconds: 86_400 } });
}
/** Two independent "instances": separate deps, no shared process lock, one shared Redis + blob. */
function twoInstances(): [Box, Box] {
  const a = box();
  const b = box(undefined, { redis: a.redis, blob: a.blob });
  return [a, b];
}
function submitReq(id: Hex, key: string): Request {
  return new Request(`https://pay.example/api/v1/agent/payment-intents/${id}/submit`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ txHash: TX }),
  });
}

test("11.1 single request under, at, and over the spend cap", async () => {
  for (const [amount, expected] of [
    [3n * USDC, 200],
    [4n * USDC, 200],
    [4n * USDC + 1n, 403],
  ] as const) {
    const h = box();
    putPolicy(h.blob, capPolicy(10n * USDC));
    seedVerified(h.blob, 6n * USDC);
    const res = await createAgentPaymentIntent(post(await bodyFor(1, amount), "one"), h.deps);
    assert.equal(res.status, expected, String(amount));
    if (expected === 403) {
      assert.equal(errorOf(res.body).reasons?.[0]?.code, "WINDOW_SPEND_LIMIT_EXCEEDED");
      assert.equal(Object.keys(h.blob.records).length, 0);
      assert.equal(Object.keys(ledgerRows(h)).length, 0);
    }
  }
});

test("11.1 two instances, 6 spent + 3 + 3 against cap 10: exactly one allowed", async () => {
  const [a, b] = twoInstances();
  putPolicy(a.blob, capPolicy(10n * USDC));
  seedVerified(a.blob, 6n * USDC);
  const [x, y] = await Promise.all([
    createAgentPaymentIntent(post(await bodyFor(1, 3n * USDC), "x"), a.deps),
    createAgentPaymentIntent(post(await bodyFor(2, 3n * USDC), "y"), b.deps),
  ]);
  assert.deepEqual([x.status, y.status].sort(), [200, 403]);
  assert.equal(Object.keys(a.blob.records).length, 1);
  assert.equal(Object.values(ledgerRows(a)).filter((r) => r.status === "RESERVED").length, 1);
  assert.ok(a.redis.conflictsReturned >= 1, "the race must have produced a CAS conflict");
});

test("11.1 two instances, 6 + 2 + 2 against cap 10: both fit exactly", async () => {
  const [a, b] = twoInstances();
  putPolicy(a.blob, capPolicy(10n * USDC));
  seedVerified(a.blob, 6n * USDC);
  const [x, y] = await Promise.all([
    createAgentPaymentIntent(post(await bodyFor(1, 2n * USDC), "x"), a.deps),
    createAgentPaymentIntent(post(await bodyFor(2, 2n * USDC), "y"), b.deps),
  ]);
  assert.deepEqual([x.status, y.status], [200, 200]);
  assert.equal(Object.values(ledgerRows(a)).filter((r) => r.status === "RESERVED").length, 2);
});

test("11.1 three concurrent requests over the cap: never more than fits", async () => {
  const [a, b] = twoInstances();
  const c = box(undefined, { redis: a.redis, blob: a.blob });
  putPolicy(a.blob, capPolicy(10n * USDC));
  seedVerified(a.blob, 6n * USDC);
  const results = await Promise.all([
    createAgentPaymentIntent(post(await bodyFor(1, 2n * USDC), "x"), a.deps),
    createAgentPaymentIntent(post(await bodyFor(2, 2n * USDC), "y"), b.deps),
    createAgentPaymentIntent(post(await bodyFor(3, 2n * USDC), "z"), c.deps),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 403]);
  const held = Object.values(ledgerRows(a))
    .filter((r) => r.status === "RESERVED")
    .reduce((sum, r) => sum + BigInt(r.amountBaseUnits), 0n);
  assert.ok(6n * USDC + held <= 10n * USDC);
});

test("11.1 different amounts concurrently, 6 + 2 + 3 against cap 10: only one", async () => {
  const [a, b] = twoInstances();
  putPolicy(a.blob, capPolicy(10n * USDC));
  seedVerified(a.blob, 6n * USDC);
  const [x, y] = await Promise.all([
    createAgentPaymentIntent(post(await bodyFor(1, 2n * USDC), "x"), a.deps),
    createAgentPaymentIntent(post(await bodyFor(2, 3n * USDC), "y"), b.deps),
  ]);
  assert.deepEqual([x.status, y.status].sort(), [200, 403]);
});

test("11.1 multiple maxSpend policies: every cap is enforced, the tighter one denies", async () => {
  const [a, b] = twoInstances();
  putPolicy(a.blob, capPolicy(10n * USDC, "pol_a"));
  putPolicy(a.blob, capPolicy(5n * USDC, "pol_b"));
  seedVerified(a.blob, 3n * USDC);
  const [x, y] = await Promise.all([
    createAgentPaymentIntent(post(await bodyFor(1, 1n * USDC), "x"), a.deps),
    createAgentPaymentIntent(post(await bodyFor(2, 1n * USDC), "y"), b.deps),
  ]);
  assert.deepEqual([x.status, y.status], [200, 200]);
  const c = await createAgentPaymentIntent(post(await bodyFor(3, 1n * USDC), "z"), a.deps);
  assert.equal(c.status, 403);
  const reasons = errorOf(c.body).reasons as { code: string; policyId?: string }[];
  assert.deepEqual(reasons.map((r) => r.policyId), ["pol_b"]);
  const rows = Object.values(ledgerRows(a)) as unknown as { policyIds: string[] }[];
  for (const row of rows) assert.deepEqual(row.policyIds.sort(), ["pol_a", "pol_b"]);
});

test("11.1 same idempotency key concurrently on two instances: one intent, one reservation", async () => {
  const [a, b] = twoInstances();
  putPolicy(a.blob, capPolicy(10n * USDC));
  const body = await bodyFor(1, 4n * USDC);
  const [x, y] = await Promise.all([
    createAgentPaymentIntent(post(body, "same"), a.deps),
    createAgentPaymentIntent(post(body, "same"), b.deps),
  ]);
  assert.equal(x.status, 200);
  assert.equal(y.status, 200);
  assert.equal(Object.keys(a.blob.records).length, 1);
  assert.equal(Object.keys(a.blob.agents?.intents ?? {}).length, 1);
  assert.equal(Object.keys(ledgerRows(a)).length, 1);
  const again = await createAgentPaymentIntent(post(body, "same"), b.deps);
  assert.equal(again.status, 200);
  assert.equal(Object.keys(ledgerRows(a)).length, 1);
  const conflict = await createAgentPaymentIntent(post(await bodyFor(1, 5n * USDC), "same"), b.deps);
  assert.equal(conflict.status, 409);
});

test("11.1 RESERVED is not verified spend; verification converts RESERVED -> CONSUMED", async () => {
  const h = box();
  putPolicy(h.blob, capPolicy(10n * USDC));
  const created = await createAgentPaymentIntent(post(await signedBody(), "pay"), h.deps);
  assert.equal(created.status, 200);
  assert.equal(ledgerRows(h)[REQUEST_ID.toLowerCase()]?.status, "RESERVED");
  assert.equal(verifiedSpendFromIntents(h.blob, merchant.address).length, 0);
  h.setVerify(async () => ({ result: okProof(), blockTimestamp: BigInt(NOW) }));
  h.setNow(NOW + 25);
  const paid = await submitAgentPaymentIntent(submitReq(REQUEST_ID, "ok"), REQUEST_ID, h.deps);
  assert.equal((paid.body as { status: string }).status, "VERIFIED");
  const row = ledgerRows(h)[REQUEST_ID.toLowerCase()];
  assert.equal(row?.status, "CONSUMED");
  assert.equal(row?.consumedAt, NOW + 25);
  assert.equal(Object.values(h.blob.records)[0]?.paidTx ?? null, null);
  // Counted once: 1 verified + 9 more fits a cap of 10, 9 + 1 unit does not.
  assert.equal((await createAgentPaymentIntent(post(await bodyFor(9, 9n * USDC + 1n), "n"), h.deps)).status, 403);
  assert.equal((await createAgentPaymentIntent(post(await bodyFor(9, 9n * USDC), "m"), h.deps)).status, 200);
});

test("11.1 failed verification releases; submitted hash does not release or count as spend", async () => {
  const h = box();
  putPolicy(h.blob, capPolicy(10n * USDC));
  await createAgentPaymentIntent(post(await signedBody(), "pay"), h.deps);
  await submitAgentPaymentIntent(submitReq(REQUEST_ID, "nf"), REQUEST_ID, h.deps);
  assert.equal(ledgerRows(h)[REQUEST_ID.toLowerCase()]?.status, "RESERVED");
  h.setNow(EXPIRES_AT + 10_000);
  await getAgentPaymentIntent(
    new Request(`https://pay.example/api/v1/agent/payment-intents/${REQUEST_ID}`, { headers: { authorization: `Bearer ${SECRET}` } }),
    REQUEST_ID,
    h.deps,
  );
  assert.equal(ledgerRows(h)[REQUEST_ID.toLowerCase()]?.status, "RESERVED", "SUBMITTED is never released");
  h.setNow(NOW + 5);
  h.setVerify(async () => ({ result: okProof({ success: false }), blockTimestamp: BigInt(NOW) }));
  const failed = await submitAgentPaymentIntent(submitReq(REQUEST_ID, "bad"), REQUEST_ID, h.deps);
  assert.equal((failed.body as { status: string }).status, "FAILED");
  assert.equal(ledgerRows(h)[REQUEST_ID.toLowerCase()]?.status, "RELEASED");
});

test("11.1 expired AWAITING_PAYMENT releases only after expiresAt + grace", async () => {
  const h = box();
  putPolicy(h.blob, capPolicy(10n * USDC));
  await createAgentPaymentIntent(post(await signedBody(), "hold"), h.deps);
  const read = () =>
    getAgentPaymentIntent(
      new Request(`https://pay.example/api/v1/agent/payment-intents/${REQUEST_ID}`, { headers: { authorization: `Bearer ${SECRET}` } }),
      REQUEST_ID,
      h.deps,
    );
  h.setNow(EXPIRES_AT);
  await read();
  assert.equal(ledgerRows(h)[REQUEST_ID.toLowerCase()]?.status, "RESERVED");
  h.setNow(EXPIRES_AT + 3600);
  await read();
  assert.equal(ledgerRows(h)[REQUEST_ID.toLowerCase()]?.status, "RELEASED");
});

test("11.1 lazy recovery during reservation releases a crashed reservation with no intent after expiry", async () => {
  const h = box();
  putPolicy(h.blob, capPolicy(10n * USDC));
  h.redis.values.set(
    ledgerKey(merchant.address),
    JSON.stringify({
      version: 1,
      reservations: {
        [rid(7)]: {
          id: rid(7), intentId: rid(7), merchant: merchant.address, amountBaseUnits: (10n * USDC).toString(),
          policyIds: ["pol_cap"], reservedAt: NOW - 100, expiresAt: NOW - 3600, status: "RESERVED",
          consumedAt: null, releasedAt: null, releaseReason: null,
        },
      },
    }),
  );
  const res = await createAgentPaymentIntent(post(await bodyFor(1, 1n * USDC), "after-crash"), h.deps);
  assert.equal(res.status, 200);
  assert.equal(ledgerRows(h)[rid(7)]?.releaseReason, "intent_never_stored");
});

test("11.1 a live crashed reservation keeps holding budget (conservative)", async () => {
  const h = box();
  putPolicy(h.blob, capPolicy(10n * USDC));
  h.redis.values.set(
    ledgerKey(merchant.address),
    JSON.stringify({
      version: 1,
      reservations: {
        [rid(7)]: {
          id: rid(7), intentId: rid(7), merchant: merchant.address, amountBaseUnits: (10n * USDC).toString(),
          policyIds: ["pol_cap"], reservedAt: NOW - 100, expiresAt: EXPIRES_AT, status: "RESERVED",
          consumedAt: null, releasedAt: null, releaseReason: null,
        },
      },
    }),
  );
  assert.equal((await createAgentPaymentIntent(post(await bodyFor(1, 1n), "x"), h.deps)).status, 403);
});

test("11.1 signature failure releases the reservation and stores no V2 request", async () => {
  const h = box();
  putPolicy(h.blob, capPolicy(10n * USDC));
  const body = await signedBody();
  // Wrong signer: same terms signed by a different account under its own merchant field.
  const forged = await signFinalRequest(validateFinalRequest(draft({ merchant: other.address, recipient: other.address })), other);
  const res = await createAgentPaymentIntent(post({ ...body, signature: forged.signature }, "forged"), h.deps);
  assert.ok(res.status >= 400 && res.status < 500, String(res.status));
  assert.equal(Object.keys(h.blob.records).length, 0);
  assert.equal(Object.keys(h.blob.agents?.intents ?? {}).length, 0);
  assert.equal(ledgerRows(h)[REQUEST_ID.toLowerCase()]?.status, "RELEASED");
  assert.equal((await createAgentPaymentIntent(post(await bodyFor(2, 10n * USDC), "full"), h.deps)).status, 200);
});

test("11.1 merchant isolation: another merchant's ledger does not affect this budget", async () => {
  const h = box();
  putPolicy(h.blob, capPolicy(10n * USDC));
  h.redis.values.set(
    ledgerKey(other.address),
    JSON.stringify({
      version: 1,
      reservations: {
        [rid(8)]: {
          id: rid(8), intentId: rid(8), merchant: other.address, amountBaseUnits: (10n * USDC).toString(),
          policyIds: ["x"], reservedAt: NOW, expiresAt: EXPIRES_AT, status: "RESERVED",
          consumedAt: null, releasedAt: null, releaseReason: null,
        },
      },
    }),
  );
  assert.equal((await createAgentPaymentIntent(post(await bodyFor(1, 10n * USDC), "x"), h.deps)).status, 200);
  assert.equal(Object.keys(ledgerRows(h, other.address)).length, 1);
});

test("11.1 CAS conflicts are retried and then succeed", async () => {
  const h = box();
  putPolicy(h.blob, capPolicy(10n * USDC));
  h.redis.injectConflicts(2);
  const res = await createAgentPaymentIntent(post(await signedBody(), "retry"), h.deps);
  assert.equal(res.status, 200);
  assert.equal(h.redis.conflictsReturned, 2);
  assert.equal(ledgerRows(h)[REQUEST_ID.toLowerCase()]?.status, "RESERVED");
});

test("11.1 exhausted CAS retries deny conservatively with 503 and create nothing", async () => {
  const h = box();
  putPolicy(h.blob, capPolicy(10n * USDC));
  h.redis.injectConflicts(5);
  const res = await createAgentPaymentIntent(post(await signedBody(), "exhaust"), h.deps);
  assert.equal(res.status, 503);
  assert.equal(errorOf(res.body).code, "policy_concurrency_unavailable");
  assert.equal(Object.keys(h.blob.records).length, 0);
  assert.equal(Object.keys(ledgerRows(h)).length, 0);
  // 503 is not remembered: a retry with the same key can succeed.
  assert.equal((await createAgentPaymentIntent(post(await signedBody(), "exhaust"), h.deps)).status, 200);
});

test("11.1 non-atomic backend: spend caps get 503, no-cap policies and no policies are unaffected", async () => {
  const h = box();
  h.deps.policyLedger = unavailablePolicyLedger();
  assert.equal((await createAgentPaymentIntent(post(await bodyFor(1, USDC), "plain"), h.deps)).status, 200);
  putPolicy(h.blob, policy({ id: "pol_amt", rules: { maxAmountBaseUnits: (5n * USDC).toString() } }));
  assert.equal((await createAgentPaymentIntent(post(await bodyFor(2, USDC), "amt"), h.deps)).status, 200);
  assert.equal((await createAgentPaymentIntent(post(await bodyFor(3, 6n * USDC), "amt-over"), h.deps)).status, 403);
  putPolicy(h.blob, capPolicy(10n * USDC));
  const capped = await createAgentPaymentIntent(post(await bodyFor(4, USDC), "cap"), h.deps);
  assert.equal(capped.status, 503);
  assert.equal(errorOf(capped.body).code, "policy_concurrency_unavailable");
  assert.equal(Object.keys(h.blob.records).length, 2);
  // Ordinary denial stays 403, not 503.
  assert.equal((await createAgentPaymentIntent(post(await bodyFor(5, 6n * USDC), "deny"), h.deps)).status, 403);
});

test("11.1 live ledger selection: Redis is atomic, JSON is unavailable unless single-instance is declared", () => {
  const names = ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "FINAL_PAY_STORE", "FINAL_POLICY_SINGLE_INSTANCE"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    for (const n of names) delete process.env[n];
    process.env.FINAL_PAY_STORE = "/tmp/final-policy-test/pay-store.json";
    assert.equal(livePolicyLedger().mode, "unavailable");
    process.env.FINAL_POLICY_SINGLE_INSTANCE = "1";
    assert.equal(livePolicyLedger().mode, "single-instance");
    delete process.env.FINAL_PAY_STORE;
    delete process.env.FINAL_POLICY_SINGLE_INSTANCE;
    process.env.KV_REST_API_URL = "https://kv.example.test";
    process.env.KV_REST_API_TOKEN = "t";
    assert.equal(livePolicyLedger().mode, "atomic");
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
});

test("11.1 the Redis ledger commits only through the Lua compare-and-set", async () => {
  const redis = createFakeRedis();
  const ledger = redisPolicyLedger({ url: "https://kv.fake", token: "t" }, redis.fetch);
  const first = await ledger.read(merchant.address);
  assert.equal(first.version, null);
  assert.equal(await ledger.commit(merchant.address, first.version, first.doc), true);
  assert.equal(await ledger.commit(merchant.address, first.version, first.doc), false, "stale version must lose");
  assert.equal(redis.evalCalls, 2);
});

test("11.1 policy, ledger, and reservation code: no reconciliation, signing, RPC, or USDC movement", () => {
  const files = ["src/lib/paymentPolicy.ts", "src/lib/paymentPolicies.ts", "src/lib/policyLedger.ts"];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const banned of [
      "reconcilePaymentRecord", "markPaid", "reconcilePayment", "payPaid", "privateKey", "walletClient",
      "signTypedData", "signMessage", "sendTransaction", "sendRawTransaction", "writeContract",
      "createPublicClient", "createWalletClient", "ARC_RPC", "verifyArcTransaction", "escrow", "checkoutObserve",
    ]) {
      assert.equal(text.includes(banned), false, `${file} contains ${banned}`);
    }
  }
  const pure = readFileSync("src/lib/paymentPolicy.ts", "utf8");
  assert.equal(pure.includes("fetch("), false);
  assert.equal(pure.includes("./payStore"), false);
});
