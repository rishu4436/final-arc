import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildOverview, buildTimeseries, LABELS, type AnalyticsRange } from "./analytics";
import { analyticsOverview, analyticsPolicies, analyticsTimeseries, parseUtcDate, type AnalyticsDeps } from "./analyticsHttp";
import { hashApiSecret, type ApiKeyRecord, type ApiKeyRuntime } from "./apiKeys";
import {
  API_SCOPES,
  DEFAULT_API_KEY_SCOPES,
  WALLET_ACTIONS,
  WALLET_AUTH_HEADERS,
  walletAuthMessage,
  type ApiScope,
} from "./apiScopes";
import { ARC_CHAIN_ID } from "./arc";
import { createFakeRedis } from "./fakeRedisRest";
import { encodePayRequest, encodeV2PayRequest } from "./payRequest";
import type { StoreFile } from "./payStore";
import {
  filePolicyLedger,
  ledgerKey,
  redisPolicyLedger,
  unavailablePolicyLedger,
  type LedgerDoc,
  type LedgerReservation,
  type PolicyLedger,
} from "./policyLedger";

const A_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const B_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const A = privateKeyToAccount(A_KEY);
const B = privateKeyToAccount(B_KEY);
const PEPPER = "analytics-test-pepper";
const NOW = 1_800_000_000; // 2027-01-15T08:00:00.000Z
const TX = ("0x" + "ab".repeat(32)) as Hex;
const SIG = ("0x" + "22".repeat(65)) as Hex;
const PAYER = "0x9999999999999999999999999999999999999999";
const RANGE: AnalyticsRange = { fromMs: Date.parse("2027-01-01T00:00:00.000Z"), toMs: Date.parse("2027-02-01T00:00:00.000Z") };
const Q_RANGE = "from=2027-01-01&to=2027-02-01";
const SECRETS = {
  analyticsA: "final_live_" + "a".repeat(43),
  otherScopesA: "final_live_" + "o".repeat(43),
  agentA: "final_live_" + "g".repeat(43),
  revokedA: "final_live_" + "r".repeat(43),
  expiredA: "final_live_" + "e".repeat(43),
  analyticsB: "final_live_" + "b".repeat(43),
};
const FORBIDDEN_STRINGS = [
  "whsec_SUPERSECRET_A",
  "whsec_SUPERSECRET_B",
  "BODY-SECRET",
  "RAW-ERROR-TEXT",
  "agent-name-private",
  "client-ref-private",
  "idem-response-private",
  "proof-private",
  PAYER,
  PAYER.toLowerCase(),
  SIG,
  hashApiSecret(SECRETS.analyticsA, PEPPER),
  SECRETS.analyticsA,
];

function rid(n: number): Hex {
  return ("0x" + n.toString(16).padStart(32, "0")) as Hex;
}

function v2Token(merchant: Address, requestId: Hex, amount: bigint, expiresAt: number): string {
  return encodeV2PayRequest({
    version: 2,
    requestId,
    merchant,
    recipient: merchant,
    amountBaseUnits: amount,
    memo: "INV",
    chainId: ARC_CHAIN_ID,
    expiresAt,
    nonce: ("0x" + "cd".repeat(32)) as Hex,
    signature: SIG,
  });
}

function rec(token: string, createdAt: string | undefined, over: Record<string, unknown> = {}) {
  return {
    token,
    id: token.slice(0, 8),
    to: A.address,
    amount: "0",
    memo: "",
    createdAt,
    views: 0,
    lastViewedAt: null,
    cancelled: false,
    cancelledAt: null,
    paidTx: null,
    webhookUrl: null,
    ...over,
  };
}

function iso(s: string): number {
  return Math.floor(Date.parse(s) / 1000);
}

const I4_VERIFIED_AT = iso("2027-01-14T10:00:00.000Z");

function keyRow(merchant: string, secret: string, scopes: readonly ApiScope[], id: string, over: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id,
    merchant,
    name: id,
    prefix: secret.slice(0, "final_live_".length + 8),
    hash: hashApiSecret(secret, PEPPER),
    scopes: [...scopes],
    enabled: true,
    revoked: false,
    createdAt: "2027-01-01T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
    ...over,
  };
}

function apiKeys(): ApiKeyRecord[] {
  return [
    keyRow(A.address, SECRETS.analyticsA, ["analytics:read"], "key_a_analytics", { lastUsedAt: "2027-01-14T00:00:00.000Z" }),
    keyRow(A.address, SECRETS.otherScopesA, API_SCOPES.filter((s) => s !== "analytics:read"), "key_a_other"),
    keyRow(A.address, SECRETS.agentA, ["agent:read", "agent:write"], "key_a_agent", { enabled: false }),
    keyRow(A.address, SECRETS.revokedA, ["analytics:read"], "key_a_revoked", { revoked: true }),
    keyRow(A.address, SECRETS.expiredA, ["analytics:read"], "key_a_expired", { expiresAt: "2027-01-10T00:00:00.000Z" }),
    keyRow(B.address, SECRETS.analyticsB, ["analytics:read"], "key_b_analytics", { lastUsedAt: "2027-01-15T00:00:00.000Z" }),
  ];
}

function fixture(): StoreFile {
  const records: Record<string, unknown> = {};
  const put = (r: ReturnType<typeof rec>) => {
    records[r.token] = r;
  };
  put(rec(encodePayRequest({ to: A.address, amount: "1", memo: "v1 open" }), "2027-01-10T00:00:00.000Z"));
  put(rec(encodePayRequest({ to: A.address, amount: "2.5", memo: "v1 paid" }), "2027-01-10T12:00:00.000Z", { paidTx: TX }));
  put(rec(encodePayRequest({ to: A.address, amount: "0.5", memo: "v1 cancel" }), "2027-01-11T00:00:00.000Z", { cancelled: true, cancelledAt: "2027-01-11T01:00:00.000Z" }));
  put(rec(v2Token(A.address, rid(1), 3_000_000n, NOW + 3600), "2027-01-12T00:00:00.000Z"));
  put(rec(v2Token(A.address, rid(2), 4_000_000n, NOW - 10), "2027-01-13T00:00:00.000Z"));
  put(rec(v2Token(A.address, rid(3), 5_000_000n, NOW + 3600), "2027-01-14T23:59:59.999Z", { paidTx: TX }));
  // Outside the range and without createdAt
  put(rec(encodePayRequest({ to: A.address, amount: "7", memo: "old" }), "2026-12-31T23:59:59.999Z"));
  put(rec(encodePayRequest({ to: A.address, amount: "8", memo: "no created" }), undefined));
  // Merchant B
  put(rec(encodePayRequest({ to: B.address, amount: "100", memo: "b open" }), "2027-01-10T00:00:00.000Z", { to: B.address }));
  put(rec(v2Token(B.address, rid(9), 9_000_000n, NOW + 3600), "2027-01-12T00:00:00.000Z", { paidTx: TX, to: B.address }));
  // Malformed
  records.junk = { token: "not-a-token", createdAt: "2027-01-10T00:00:00.000Z" };

  const intent = (id: number, over: Record<string, unknown>) => ({
    intentId: rid(id),
    requestId: rid(1),
    merchant: A.address,
    createdAt: "2027-01-12T00:00:00.000Z",
    agentId: "desk",
    agentName: "agent-name-private",
    clientReference: "client-ref-private",
    status: "AWAITING_PAYMENT",
    submittedTxHash: null,
    verifiedTxHash: null,
    failureReason: null,
    proofStatus: null,
    binding: { boundToIntent: false, reason: null },
    proof: { note: "proof-private", from: PAYER },
    ...over,
  });
  const intents: Record<string, unknown> = {
    i1: intent(101, { requestId: rid(1) }),
    i2: intent(102, { requestId: rid(2), createdAt: "2027-01-13T00:00:00.000Z" }),
    i3: intent(103, { status: "SUBMITTED", submittedTxHash: TX, proofStatus: "NOT_FOUND" }),
    i4: intent(104, { requestId: rid(3), status: "VERIFIED", verifiedTxHash: TX, proofStatus: "VERIFIED", verifiedAt: I4_VERIFIED_AT, amountBaseUnits: "5000000" }),
    i5: intent(105, { status: "FAILED", proofStatus: "INVALID" }),
    i6: intent(106, { status: "SUBMITTED", proofStatus: "PARTIAL" }),
    i7: intent(107, { status: "SUBMITTED", proofStatus: "UNAVAILABLE" }),
    i8: intent(108, { requestId: rid(3), status: "VERIFIED", proofStatus: "VERIFIED" }),
    i9: intent(109, { status: "BOGUS" }),
    ib: intent(199, { merchant: B.address, requestId: rid(9), status: "VERIFIED", verifiedAt: I4_VERIFIED_AT, amountBaseUnits: "9000000", proofStatus: "VERIFIED" }),
  };

  const policy = (id: string, merchant: string, enabled: boolean, rules: Record<string, unknown>) => ({
    id,
    merchant,
    name: id.toUpperCase(),
    enabled,
    createdAt: "2027-01-01T00:00:00.000Z",
    updatedAt: "2027-01-01T00:00:00.000Z",
    version: 1,
    rules,
  });
  const denial = (id: string, merchant: string, at: string, reasons: unknown[]) => ({
    id,
    merchant,
    agentId: "desk",
    recipient: PAYER,
    token: "0x3600000000000000000000000000000000000000",
    chainId: ARC_CHAIN_ID,
    amountBaseUnits: "1",
    evaluatedAt: iso(at),
    policyVersion: 1,
    policyIds: [],
    reasons,
    createdAt: at,
  });

  return {
    records: records as StoreFile["records"],
    agents: { intents, idempotency: { x: { merchant: A.address, body: "idem-response-private" } } },
    policies: {
      records: {
        pA1: policy("pol_a1", A.address, true, { maxSpendBaseUnits: "10000000", windowSeconds: 86_400 }),
        pA2: policy("pol_a2", A.address, false, { maxAmountBaseUnits: "1" }),
        pA3: policy("pol_a3", A.address, true, { maxAmountBaseUnits: "1000000" }),
        pB1: policy("pol_b1", B.address, true, { maxSpendBaseUnits: "1", windowSeconds: 60 }),
      },
      // Stale Phase 11 section. Must never be read.
      reservations: { stale: { id: "stale", merchant: A.address, amountBaseUnits: "777777777", reservedAt: NOW, status: "RESERVED" } },
      denials: {
        d1: denial("d1", A.address, "2027-01-12T00:00:00.000Z", [{ code: "AMOUNT_LIMIT_EXCEEDED", message: "m", policyId: "pol_a1" }]),
        d2: denial("d2", A.address, "2027-01-13T00:00:00.000Z", [
          { code: "WINDOW_SPEND_LIMIT_EXCEEDED", message: "m", policyId: "pol_a1" },
          { code: "RECIPIENT_NOT_ALLOWED", message: "m", policyId: "pol_a3" },
        ]),
        d3: denial("d3", A.address, "2027-01-14T00:00:00.000Z", [{ code: "INVALID_POLICY", message: "m" }]),
        dOld: denial("dOld", A.address, "2026-06-01T00:00:00.000Z", [{ code: "AMOUNT_LIMIT_EXCEEDED", message: "m" }]),
        dB: denial("dB", B.address, "2027-01-12T00:00:00.000Z", [{ code: "AGENT_NOT_ALLOWED", message: "m", policyId: "pol_b1" }]),
      },
    },
    webhooks: {
      endpoints: {
        whA: { id: "whA", merchant: A.address, url: "https://a.example/hook", enabled: true, events: [], secret: "whsec_SUPERSECRET_A", createdAt: "x", updatedAt: "x" },
        whA2: { id: "whA2", merchant: A.address, url: "https://a.example/off", enabled: false, events: [], secret: "whsec_SUPERSECRET_A", createdAt: "x", updatedAt: "x" },
        whB: { id: "whB", merchant: B.address, url: "https://b.example/hook", enabled: true, events: [], secret: "whsec_SUPERSECRET_B", createdAt: "x", updatedAt: "x" },
      },
      deliveries: {
        a1: dlv("a1", "whA", A.address, 1, "success", 200),
        a2: dlv("a2", "whA", A.address, 2, "failed", 500),
        a3: dlv("a3", "whA", A.address, 1, "retrying", null),
        a4: dlv("a4", "whA", A.address, 3, "failed", 404),
        aOld: { ...dlv("aOld", "whA", A.address, 1, "failed", 500), createdAt: "2026-01-01T00:00:00.000Z" },
        aForeign: dlv("aForeign", "whB", A.address, 1, "failed", 500),
        b1: dlv("b1", "whB", B.address, 1, "success", 200),
      },
    },
    apiKeys: { keys: Object.fromEntries(apiKeys().map((k) => [k.id, k])) },
    escrows: {
      records: {
        ...Object.fromEntries(
          (["CREATED", "OPEN", "FUNDED", "RELEASED", "REFUNDED", "CANCELLED"] as const).map((state, i) => [
            `e${i}`,
            escrow(A.address, state, String((i + 1) * 1_000_000)),
          ]),
        ),
        eBig1: escrow(A.address, "FUNDED", "340282366920938463463374607431768211455"),
        eBad: escrow(A.address, "FUNDED", "-5"),
        eB: escrow(B.address, "FUNDED", "50000000"),
      },
    },
  };
}

function dlv(id: string, webhookId: string, merchant: string, attempt: number, status: string, httpStatus: number | null) {
  return {
    deliveryId: id,
    eventId: "evt_" + id,
    eventType: "payment_request.created",
    webhookId,
    merchant,
    attempt,
    status,
    httpStatus,
    createdAt: "2027-01-12T00:00:00.000Z",
    attemptedAt: "2027-01-12T00:00:00.000Z",
    nextRetryAt: null,
    error: "RAW-ERROR-TEXT",
    body: "BODY-SECRET",
  };
}

function escrow(creator: string, state: string, amountBaseUnits: string) {
  return {
    escrowId: "0x" + "ee".repeat(32),
    version: 1,
    chainId: ARC_CHAIN_ID,
    token: "0x3600000000000000000000000000000000000000",
    payer: PAYER,
    recipient: creator,
    creator,
    amountBaseUnits,
    expiresAt: NOW + 1000,
    createdAt: "2027-01-12T00:00:00.000Z",
    state,
    openTxHash: null,
    fundingTxHash: null,
    releaseTxHash: null,
    refundTxHash: null,
    cancelTxHash: null,
    usedNonces: [],
  };
}

function reservation(id: string, merchant: string, amount: string, status: LedgerReservation["status"], over: Partial<LedgerReservation> = {}): LedgerReservation {
  return {
    id,
    intentId: id,
    merchant,
    amountBaseUnits: amount,
    policyIds: ["pol_a1"],
    reservedAt: NOW - 100,
    expiresAt: NOW - 50_000, // past expiry + grace: recovery WOULD release it, analytics must not
    status,
    consumedAt: null,
    releasedAt: null,
    releaseReason: null,
    ...over,
  };
}

function ledgerDocA(): LedgerDoc {
  return {
    version: 1,
    reservations: {
      res1: reservation("res1", A.address, "2000000", "RESERVED"),
      [rid(104)]: reservation(rid(104), A.address, "5000000", "CONSUMED", { consumedAt: I4_VERIFIED_AT }),
      res3: reservation("res3", A.address, "1000000", "RELEASED", { releasedAt: NOW - 10, releaseReason: "intent_failed" }),
      smuggled: reservation("smuggled", B.address, "999000000", "RESERVED"),
    },
  };
}

type Harness = {
  blob: StoreFile;
  deps: AnalyticsDeps;
  commits: number;
  reads: string[];
  redis: ReturnType<typeof createFakeRedis>;
  touched: string[];
};

function harness(opts: { ledger?: "redis" | "unavailable"; blob?: StoreFile; readFails?: boolean } = {}): Harness {
  const blob = opts.blob ?? fixture();
  const redis = createFakeRedis();
  redis.values.set(ledgerKey(A.address), JSON.stringify(ledgerDocA()));
  const base: PolicyLedger =
    opts.ledger === "unavailable" ? unavailablePolicyLedger() : redisPolicyLedger({ url: "https://kv.fake", token: "t" }, redis.fetch);
  const h: Harness = { blob, commits: 0, reads: [], redis, touched: [], deps: undefined as unknown as AnalyticsDeps };
  const keys = apiKeys();
  const apiKeyAuth: ApiKeyRuntime = {
    nowSeconds: () => NOW,
    pepper: PEPPER,
    rateLimitPerMinute: 1_000_000,
    listKeys: async () => keys.map((k) => ({ ...k })),
    upsertKey: async () => {
      throw new Error("analytics must not upsert keys");
    },
    createKey: async () => {
      throw new Error("analytics must not create keys");
    },
    touchLastUsed: async (id) => {
      h.touched.push(id);
    },
  };
  // Full ledger passed in, with a commit spy. Analytics only has read() in its type.
  const spy: PolicyLedger = {
    mode: base.mode,
    read: async (merchant) => {
      h.reads.push(merchant);
      return base.read(merchant);
    },
    commit: async (...args) => {
      h.commits += 1;
      return base.commit(...args);
    },
  };
  h.deps = {
    nowSeconds: () => NOW,
    readBlob: async () => {
      if (opts.readFails) throw new Error("redis down");
      return blob;
    },
    ledger: spy,
    apiKeyAuth,
  };
  return h;
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://final.test${path}`, { headers });
}

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

async function walletHeaders(action: string, account = A, signer = account) {
  const signature = await signer.signMessage({ message: walletAuthMessage(action, account.address, NOW) });
  return {
    [WALLET_AUTH_HEADERS.merchant]: account.address,
    [WALLET_AUTH_HEADERS.timestamp]: String(NOW),
    [WALLET_AUTH_HEADERS.signature]: signature,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------------------------------------------------------------------------
// Scope model
// ---------------------------------------------------------------------------

test("analytics:read is a known, opt-in scope and analytics.read is a wallet action", () => {
  assert.equal(API_SCOPES.includes("analytics:read"), true);
  assert.equal(DEFAULT_API_KEY_SCOPES.includes("analytics:read"), false);
  assert.equal(WALLET_ACTIONS.analyticsRead, "analytics.read");
});

// ---------------------------------------------------------------------------
// Payment requests
// ---------------------------------------------------------------------------

test("payment lifecycle: V1 and V2, recorded paid from stored paidTx only, exact sums, range by createdAt", async () => {
  const h = harness();
  const res = await analyticsOverview(get(`/api/v1/analytics/overview?${Q_RANGE}`, bearer(SECRETS.analyticsA)), h.deps);
  assert.equal(res.status, 200);
  const body = res.body as Body;
  assert.equal(body.merchant, A.address);
  assert.deepEqual(body.range, { from: "2027-01-01T00:00:00.000Z", to: "2027-02-01T00:00:00.000Z", timezone: "UTC", bounds: "[from, to)" });
  const p = body.sections.payments;
  assert.equal(p.total, 6);
  assert.equal(p.open, 2);
  assert.equal(p.recordedPaid, 2);
  assert.equal(p.expired, 1);
  assert.equal(p.cancelled, 1);
  assert.equal(p.requestedBaseUnits, "16000000");
  assert.equal(p.recordedPaidBaseUnits, "7500000");
  assert.equal(p.outstandingBaseUnits, "4000000");
  assert.equal(p.averageRequestBaseUnits, "2666666");
  assert.deepEqual(p.completionRate, { numerator: 2, denominator: 6, rate: 0.3333 });
  assert.deepEqual(p.expirationRate, { numerator: 1, denominator: 6, rate: 0.1667 });
  assert.deepEqual(p.cancellationRate, { numerator: 1, denominator: 6, rate: 0.1667 });
  assert.deepEqual(p.byVersion, { v1: 3, v2: 3 });
  assert.equal(p.missingCreatedAt, 1);
  assert.match(p.label, /Recorded paid/);
  assert.equal("verified" in p, false);
  assert.equal("paidAt" in p, false);
});

test("a stored row that is not yet reconciled stays open; analytics never infers payment", () => {
  const blob = fixture();
  const out = buildOverview({ store: blob, merchant: A.address, nowSeconds: NOW, range: RANGE, sections: ["payments"] });
  // Only paidTx moves a row to recorded paid; open V2 rid(1) stays open even though an intent references it.
  assert.equal(out.payments?.open, 2);
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

test("agent intents: stored statuses, derived EXPIRED, proof breakdown, verifiedAt basis", () => {
  const out = buildOverview({ store: fixture(), merchant: A.address, nowSeconds: NOW, range: RANGE, sections: ["agents"] });
  const a = out.agents!;
  assert.equal(a.created, 8);
  assert.equal(a.awaitingPayment, 1);
  assert.equal(a.expired, 1);
  assert.equal(a.submitted, 3);
  assert.equal(a.verified, 2);
  assert.equal(a.failed, 1);
  assert.equal(a.malformed, 1);
  assert.deepEqual(a.proofStatus, { VERIFIED: 2, PARTIAL: 1, INVALID: 1, NOT_FOUND: 1, UNAVAILABLE: 1, NONE: 2 });
  // Only i4 has verifiedAt in range. PARTIAL/NOT_FOUND/UNAVAILABLE/SUBMITTED never count as verified.
  assert.deepEqual(a.verifiedInRange, { basis: "verifiedAt", count: 1, baseUnits: "5000000", missingAmount: 0 });
  assert.equal(a.verifiedMissingVerifiedAt, 1);
  assert.equal(a.policyDenied, 3);
});

test("EXPIRED is derived only while AWAITING_PAYMENT and at/after the joined request expiry", () => {
  const blob = fixture();
  const before = buildOverview({ store: blob, merchant: A.address, nowSeconds: NOW - 11, range: RANGE, sections: ["agents"] });
  assert.equal(before.agents?.expired, 0);
  assert.equal(before.agents?.awaitingPayment, 2);
  const at = buildOverview({ store: blob, merchant: A.address, nowSeconds: NOW - 10, range: RANGE, sections: ["agents"] });
  assert.equal(at.agents?.expired, 1);
  // SUBMITTED on an expired request stays SUBMITTED.
  (blob.agents!.intents.i3 as Record<string, unknown>).requestId = rid(2);
  const sub = buildOverview({ store: blob, merchant: A.address, nowSeconds: NOW, range: RANGE, sections: ["agents"] });
  assert.equal(sub.agents?.submitted, 3);
  // Request missing from store: cannot derive expiry; counted as awaiting without request.
  (blob.agents!.intents.i1 as Record<string, unknown>).requestId = rid(55);
  const unjoined = buildOverview({ store: blob, merchant: A.address, nowSeconds: NOW, range: RANGE, sections: ["agents"] });
  assert.equal(unjoined.agents?.awaitingWithoutRequest, 1);
});

// ---------------------------------------------------------------------------
// Policies and reservations
// ---------------------------------------------------------------------------

test("policies: enabled/disabled, denials by code and by policy, unattributed, ranged by evaluatedAt", () => {
  const out = buildOverview({ store: fixture(), merchant: A.address, nowSeconds: NOW, range: RANGE, sections: ["policies"] });
  const p = out.policies!;
  assert.equal(p.total, 3);
  assert.equal(p.enabled, 2);
  assert.equal(p.disabled, 1);
  assert.equal(p.withSpendCap, 1);
  assert.equal(p.denials.total, 3);
  assert.deepEqual(p.denials.byCode, {
    AMOUNT_LIMIT_EXCEEDED: 1,
    WINDOW_SPEND_LIMIT_EXCEEDED: 1,
    RECIPIENT_NOT_ALLOWED: 1,
    INVALID_POLICY: 1,
  });
  assert.deepEqual(p.denials.byPolicy, [
    { policyId: "pol_a1", name: "POL_A1", count: 2 },
    { policyId: "pol_a3", name: "POL_A3", count: 1 },
  ]);
  assert.equal(p.denials.unattributedReasons, 1);
});

test("policies route: reservations by status and policy, utilization via committedForCap, ledger untouched", async () => {
  const h = harness();
  const before = h.redis.values.get(ledgerKey(A.address));
  const res = await analyticsPolicies(get(`/api/v1/analytics/policies?${Q_RANGE}`, bearer(SECRETS.analyticsA)), h.deps);
  assert.equal(res.status, 200);
  const p = (res.body as Body).sections.policies;
  assert.equal(p.reservations.available, true);
  assert.equal(p.reservations.label, "Reserved / held — not funds");
  // Stored statuses as stored. res1 is past expiry+grace; analytics does NOT release it. Smuggled B row excluded.
  assert.deepEqual(p.reservations.byStatus, {
    RESERVED: { count: 1, baseUnits: "2000000" },
    CONSUMED: { count: 1, baseUnits: "5000000" },
    RELEASED: { count: 1, baseUnits: "1000000" },
  });
  assert.deepEqual(p.reservations.byPolicy, [
    {
      policyId: "pol_a1",
      name: "POL_A1",
      byStatus: {
        RESERVED: { count: 1, baseUnits: "2000000" },
        CONSUMED: { count: 1, baseUnits: "5000000" },
        RELEASED: { count: 1, baseUnits: "1000000" },
      },
    },
  ]);
  // verified i4 5M (CONSUMED row for the same intent counted once) + RESERVED 2M = 7M of 10M. RELEASED = 0.
  assert.deepEqual(p.utilization, [
    {
      policyId: "pol_a1",
      name: "POL_A1",
      capBaseUnits: "10000000",
      windowSeconds: 86_400,
      label: "Committed (verified + held) / cap",
      available: true,
      committedBaseUnits: "7000000",
      utilizationBps: 7000,
    },
  ]);
  assert.equal(JSON.stringify(res.body).includes("777777777"), false, "stale policies.reservations must not be read");
  assert.equal(JSON.stringify(res.body).includes("999000000"), false);
  assert.equal(JSON.stringify(res.body).includes("reservedAt"), false, "no raw ledger document");
  assert.equal(h.commits, 0);
  assert.equal(h.redis.evalCalls, 0);
  assert.equal(h.redis.values.get(ledgerKey(A.address)), before);
  assert.deepEqual(h.reads, [A.address]);
});

test("ledger unavailable: reservation and utilization report unavailable, never zero", async () => {
  const h = harness({ ledger: "unavailable" });
  const res = await analyticsPolicies(get(`/api/v1/analytics/policies?${Q_RANGE}`, bearer(SECRETS.analyticsA)), h.deps);
  assert.equal(res.status, 200);
  const p = (res.body as Body).sections.policies;
  assert.deepEqual(p.reservations, { available: false, label: LABELS.reservations, reason: "ledger_unavailable" });
  assert.equal(p.utilization.length, 1);
  assert.equal(p.utilization[0].available, false);
  assert.equal(p.utilization[0].committedBaseUnits, null);
  assert.equal(p.utilization[0].utilizationBps, null);
  // Counts that do not need the ledger still work.
  assert.equal(p.enabled, 2);
  assert.equal(p.denials.total, 3);
  assert.ok((res.body as Body).notes.some((n: string) => /unavailable, not zero/.test(n)));
});

test("policies without a spend cap need no ledger; a merchant with no ledger key reads as empty", async () => {
  const h = harness();
  const res = await analyticsPolicies(get(`/api/v1/analytics/policies?${Q_RANGE}`, bearer(SECRETS.analyticsB)), h.deps);
  const p = (res.body as Body).sections.policies;
  assert.equal(p.total, 1);
  assert.equal(p.reservations.available, true);
  assert.deepEqual(p.reservations.byStatus.RESERVED, { count: 0, baseUnits: "0" });
  assert.equal(p.utilization[0].policyId, "pol_b1");
  assert.equal(h.redis.values.has(ledgerKey(B.address)), false, "a read never creates a ledger key");
});

test("overview never reads the ledger", async () => {
  const h = harness();
  await analyticsOverview(get(`/api/v1/analytics/overview?${Q_RANGE}`, bearer(SECRETS.analyticsA)), h.deps);
  await analyticsTimeseries(get(`/api/v1/analytics/timeseries?metric=policy_denials&${Q_RANGE}`, bearer(SECRETS.analyticsA)), h.deps);
  assert.deepEqual(h.reads, []);
});

// ---------------------------------------------------------------------------
// Webhooks, API keys, escrows
// ---------------------------------------------------------------------------

test("webhooks: status counts, retries, status classes, retained-window label", () => {
  const out = buildOverview({ store: fixture(), merchant: A.address, nowSeconds: NOW, range: RANGE, sections: ["webhooks"] });
  const w = out.webhooks!;
  assert.equal(w.retention, "Last 100 deliveries per endpoint");
  assert.deepEqual(w.endpoints, { total: 2, enabled: 1, disabled: 1 });
  assert.equal(w.deliveries.attempts, 4);
  assert.equal(w.deliveries.success, 1);
  assert.equal(w.deliveries.failed, 2);
  assert.equal(w.deliveries.retrying, 1);
  assert.equal(w.deliveries.retryAttempts, 2);
  assert.deepEqual(w.deliveries.successRate, { numerator: 1, denominator: 4, rate: 0.25 });
  assert.deepEqual(w.deliveries.failureCategories, { "3xx": 0, "4xx": 1, "5xx": 1, no_response: 1, other: 0 });
});

test("api keys: public state only", () => {
  const out = buildOverview({ store: fixture(), merchant: A.address, nowSeconds: NOW, range: RANGE, sections: ["apiKeys"] });
  assert.deepEqual(out.apiKeys, {
    basis: "current_state",
    total: 5,
    active: 2,
    disabled: 1,
    revoked: 1,
    expired: 1,
    withAnalyticsScope: 3,
    lastUsedAt: "2027-01-14T00:00:00.000Z",
  });
});

test("escrows: every state, exact big amounts, creator isolation, malformed counted", () => {
  const out = buildOverview({ store: fixture(), merchant: A.address, nowSeconds: NOW, range: RANGE, sections: ["escrows"] });
  const e = out.escrows!;
  assert.equal(e.total, 7);
  assert.deepEqual(e.byState.CREATED, { count: 1, baseUnits: "1000000" });
  assert.deepEqual(e.byState.OPEN, { count: 1, baseUnits: "2000000" });
  assert.deepEqual(e.byState.FUNDED, { count: 2, baseUnits: (340282366920938463463374607431768211455n + 3_000_000n).toString() });
  assert.deepEqual(e.byState.RELEASED, { count: 1, baseUnits: "4000000" });
  assert.deepEqual(e.byState.REFUNDED, { count: 1, baseUnits: "5000000" });
  assert.deepEqual(e.byState.CANCELLED, { count: 1, baseUnits: "6000000" });
  assert.equal(e.malformed, 1);
});

// ---------------------------------------------------------------------------
// Isolation, empty, old stores, secrets
// ---------------------------------------------------------------------------

test("merchant isolation across all eight sources", async () => {
  const h = harness();
  const resB = await analyticsOverview(get(`/api/v1/analytics/overview?${Q_RANGE}`, bearer(SECRETS.analyticsB)), h.deps);
  const s = (resB.body as Body).sections;
  assert.equal((resB.body as Body).merchant, B.address);
  // 1 payment requests
  assert.equal(s.payments.total, 2);
  assert.equal(s.payments.requestedBaseUnits, "109000000");
  assert.equal(s.payments.recordedPaidBaseUnits, "9000000");
  // 2 agent intents
  assert.equal(s.agents.created, 1);
  assert.equal(s.agents.verifiedInRange.baseUnits, "9000000");
  // 3 denials, 4 policies
  assert.deepEqual(s.policies.denials.byCode, { AGENT_NOT_ALLOWED: 1 });
  assert.equal(s.policies.total, 1);
  // 6 webhooks
  assert.deepEqual(s.webhooks.endpoints, { total: 1, enabled: 1, disabled: 0 });
  assert.equal(s.webhooks.deliveries.attempts, 1);
  // 7 escrows
  assert.equal(s.escrows.total, 1);
  assert.deepEqual(s.escrows.byState.FUNDED, { count: 1, baseUnits: "50000000" });
  // 8 api keys
  assert.equal(s.apiKeys.total, 1);
  assert.equal(s.apiKeys.lastUsedAt, "2027-01-15T00:00:00.000Z");
  // 5 ledger: B's route reads B's key only and A's rows never appear.
  const pol = await analyticsPolicies(get(`/api/v1/analytics/policies?${Q_RANGE}`, bearer(SECRETS.analyticsB)), h.deps);
  assert.deepEqual(h.reads, [B.address]);
  assert.deepEqual((pol.body as Body).sections.policies.reservations.byStatus.CONSUMED, { count: 0, baseUnits: "0" });
  // A's (and the smuggled) ledger figures are absent from B's response.
  const text = JSON.stringify([resB.body, pol.body]);
  for (const needle of ["16000000", "pol_a1", "whA", "key_a_", "7000000"]) assert.equal(text.includes(needle), false, needle);
  // B's wallet-signed request sees B too.
  const wallet = await analyticsOverview(get(`/api/v1/analytics/overview?${Q_RANGE}`, await walletHeaders(WALLET_ACTIONS.analyticsRead, B)), h.deps);
  assert.equal((wallet.body as Body).sections.payments.total, 2);
});

test("empty merchant and old stores with missing sections return zeros, not errors", async () => {
  const fresh = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
  const out = buildOverview({
    store: fixture(),
    merchant: fresh.address,
    nowSeconds: NOW,
    range: RANGE,
    sections: ["payments", "agents", "policies", "webhooks", "escrows", "apiKeys"],
  });
  assert.equal(out.payments?.total, 0);
  assert.equal(out.payments?.averageRequestBaseUnits, null);
  assert.equal(out.payments?.completionRate.rate, null);
  assert.equal(out.agents?.created, 0);
  assert.equal(out.policies?.total, 0);
  assert.equal(out.webhooks?.deliveries.successRate.rate, null);
  assert.equal(out.escrows?.total, 0);
  assert.equal(out.apiKeys?.total, 0);

  const old = { records: fixture().records } as StoreFile;
  const legacy = buildOverview({
    store: old,
    merchant: A.address,
    nowSeconds: NOW,
    range: RANGE,
    sections: ["payments", "agents", "policies", "webhooks", "escrows", "apiKeys"],
  });
  assert.equal(legacy.payments?.total, 6);
  assert.equal(legacy.agents?.created, 0);
  assert.equal(legacy.policies?.denials.total, 0);
  assert.equal(legacy.webhooks?.endpoints.total, 0);
  const h = harness({ blob: old });
  const pol = await analyticsPolicies(get(`/api/v1/analytics/policies?${Q_RANGE}`, bearer(SECRETS.analyticsA)), h.deps);
  assert.equal(pol.status, 200);
  assert.equal(((pol.body as Body).sections.policies.utilization as unknown[]).length, 0);
});

test("responses never contain secrets, bodies, raw errors, payer data, agent names, signatures, or proof contents", async () => {
  const h = harness();
  const auth = bearer(SECRETS.analyticsA);
  const bodies = [
    (await analyticsOverview(get(`/api/v1/analytics/overview?${Q_RANGE}`, auth), h.deps)).body,
    (await analyticsPolicies(get(`/api/v1/analytics/policies?${Q_RANGE}`, auth), h.deps)).body,
  ];
  for (const metric of ["requests_created", "requested_volume", "agent_verified", "agent_verified_volume", "policy_denials"]) {
    bodies.push((await analyticsTimeseries(get(`/api/v1/analytics/timeseries?metric=${metric}&${Q_RANGE}`, auth), h.deps)).body);
  }
  const text = JSON.stringify(bodies);
  for (const needle of FORBIDDEN_STRINGS) assert.equal(text.includes(needle), false, needle);
  for (const key of ['"hash"', '"secret"', '"body"', '"error"', '"token"', '"paidTx"', '"payer"', '"agentName"', '"clientReference"', '"signature"', '"proof"', '"idempotency"']) {
    assert.equal(text.includes(key), false, key);
  }
});

// ---------------------------------------------------------------------------
// Dates and time series
// ---------------------------------------------------------------------------

test("strict UTC date parsing", () => {
  assert.equal(parseUtcDate("2027-01-01"), Date.parse("2027-01-01T00:00:00.000Z"));
  assert.equal(parseUtcDate("2027-01-01T05:30:00Z"), Date.parse("2027-01-01T05:30:00.000Z"));
  assert.equal(parseUtcDate("2027-01-01T05:30:00.123Z"), Date.parse("2027-01-01T05:30:00.123Z"));
  for (const bad of ["2027-02-30", "2027-13-01", "2027-01-01T05:30:00+05:30", "2027-01-01T05:30:00", "1700000000", "", "yesterday", "2027-1-1", "2027-01-01T24:00Z"]) {
    assert.equal(parseUtcDate(bad), null, bad);
  }
});

test("query validation: invalid, reversed, oversized, unknown metric/granularity/params", async () => {
  const h = harness();
  const auth = bearer(SECRETS.analyticsA);
  const cases: [string, (r: Request, d: AnalyticsDeps) => Promise<{ status: number; body: Record<string, unknown> }>][] = [
    ["/api/v1/analytics/overview?from=nope", analyticsOverview],
    ["/api/v1/analytics/overview?from=2027-02-01&to=2027-01-01", analyticsOverview],
    ["/api/v1/analytics/overview?from=2027-01-01&to=2027-01-01", analyticsOverview],
    ["/api/v1/analytics/overview?from=2025-01-01&to=2027-01-01", analyticsOverview],
    ["/api/v1/analytics/overview?sections=payments,secrets", analyticsOverview],
    ["/api/v1/analytics/overview?sections=", analyticsOverview],
    ["/api/v1/analytics/overview?merchant=" + B.address, analyticsOverview],
    ["/api/v1/analytics/overview?from=2027-01-01&from=2027-01-02", analyticsOverview],
    ["/api/v1/analytics/policies?merchant=" + B.address, analyticsPolicies],
    ["/api/v1/analytics/timeseries?from=2027-01-01", analyticsTimeseries],
    ["/api/v1/analytics/timeseries?metric=paid_volume&" + Q_RANGE, analyticsTimeseries],
    ["/api/v1/analytics/timeseries?metric=requests_created&granularity=minute&" + Q_RANGE, analyticsTimeseries],
    ["/api/v1/analytics/timeseries?metric=requests_created&granularity=hour&from=2027-01-01&to=2027-01-08T00:00:01Z", analyticsTimeseries],
    ["/api/v1/analytics/timeseries?metric=requests_created&granularity=day&from=2026-01-01&to=2027-01-03", analyticsTimeseries],
    ["/api/v1/analytics/timeseries?metric=requests_created&field=amount&" + Q_RANGE, analyticsTimeseries],
  ];
  for (const [path, fn] of cases) {
    const res = await fn(get(path, auth), h.deps);
    assert.equal(res.status, 400, path);
    assert.equal((res.body as Body).error.code, "invalid_request", path);
  }
  const ok7 = await analyticsTimeseries(get("/api/v1/analytics/timeseries?metric=requests_created&granularity=hour&from=2027-01-01&to=2027-01-08", auth), h.deps);
  assert.equal(ok7.status, 200);
  assert.equal((ok7.body as Body).sections.timeseries.buckets.length, 168);
  const ok366 = await analyticsTimeseries(get("/api/v1/analytics/timeseries?metric=requests_created&from=2026-01-01&to=2027-01-02", auth), h.deps);
  assert.equal(ok366.status, 200);
  assert.equal((ok366.body as Body).sections.timeseries.buckets.length, 366);
  const smuggled = await analyticsOverview(get("/api/v1/analytics/overview?api_key=" + SECRETS.analyticsA), h.deps);
  assert.equal(smuggled.status, 401);
});

test("default range is the last 30 days ending now", async () => {
  const h = harness();
  const res = await analyticsOverview(get("/api/v1/analytics/overview", bearer(SECRETS.analyticsA)), h.deps);
  assert.equal(res.status, 200);
  assert.equal((res.body as Body).range.to, new Date(NOW * 1000).toISOString());
  assert.equal((res.body as Body).range.from, new Date(NOW * 1000 - 30 * 86_400_000).toISOString());
});

test("timeseries: UTC day buckets, midnight boundary, zero fill, volumes as strings", () => {
  const blob = fixture();
  const range = { fromMs: Date.parse("2027-01-09T00:00:00.000Z"), toMs: Date.parse("2027-01-16T00:00:00.000Z") };
  const counts = buildTimeseries({ store: blob, merchant: A.address, nowSeconds: NOW, range, metric: "requests_created", granularity: "day" });
  assert.equal(counts.basis, "createdAt");
  assert.equal(counts.unit, "count");
  assert.deepEqual(
    counts.buckets.map((b) => [b.start.slice(0, 10), b.value]),
    [
      ["2027-01-09", 0],
      ["2027-01-10", 2],
      ["2027-01-11", 1],
      ["2027-01-12", 1],
      ["2027-01-13", 1],
      ["2027-01-14", 1], // 23:59:59.999Z stays on the 14th
      ["2027-01-15", 0],
    ],
  );
  assert.equal(counts.total, 6);
  assert.equal(counts.excluded, 1);
  const vol = buildTimeseries({ store: blob, merchant: A.address, nowSeconds: NOW, range, metric: "requested_volume", granularity: "day" });
  assert.equal(vol.unit, "base_units");
  assert.equal(vol.buckets[1].value, "3500000");
  assert.equal(vol.total, "16000000");
  // A row at exactly 00:00:00.000Z on the 15th moves into the 15th, and is excluded when to=15th.
  const r = rec(encodePayRequest({ to: A.address, amount: "1", memo: "midnight" }), "2027-01-15T00:00:00.000Z");
  (blob.records as Record<string, unknown>)[r.token] = r;
  const mid = buildTimeseries({ store: blob, merchant: A.address, nowSeconds: NOW, range, metric: "requests_created", granularity: "day" });
  assert.equal(mid.buckets[6].value, 1);
  const cut = buildTimeseries({
    store: blob,
    merchant: A.address,
    nowSeconds: NOW,
    range: { fromMs: range.fromMs, toMs: Date.parse("2027-01-15T00:00:00.000Z") },
    metric: "requests_created",
    granularity: "day",
  });
  assert.equal(cut.buckets.length, 6);
  assert.equal(cut.total, 6);
});

test("timeseries: agent verified by verifiedAt (hour buckets), denials by evaluatedAt", () => {
  const blob = fixture();
  const range = { fromMs: Date.parse("2027-01-14T08:00:00.000Z"), toMs: Date.parse("2027-01-14T12:00:00.000Z") };
  const v = buildTimeseries({ store: blob, merchant: A.address, nowSeconds: NOW, range, metric: "agent_verified", granularity: "hour" });
  assert.equal(v.basis, "verifiedAt");
  assert.deepEqual(v.buckets.map((b) => b.value), [0, 0, 1, 0]);
  assert.equal(v.excluded, 1, "VERIFIED without verifiedAt is excluded, not guessed");
  const vv = buildTimeseries({ store: blob, merchant: A.address, nowSeconds: NOW, range, metric: "agent_verified_volume", granularity: "hour" });
  assert.deepEqual(vv.buckets.map((b) => b.value), ["0", "0", "5000000", "0"]);
  const d = buildTimeseries({ store: blob, merchant: A.address, nowSeconds: NOW, range: RANGE, metric: "policy_denials", granularity: "day" });
  assert.equal(d.basis, "evaluatedAt");
  assert.equal(d.total, 3);
  assert.equal(d.buckets.length, 31);
});

test("there is no paid-over-time metric for normal payment requests", async () => {
  const h = harness();
  for (const metric of ["paid_volume", "recorded_paid", "paid", "verified_volume"]) {
    const res = await analyticsTimeseries(get(`/api/v1/analytics/timeseries?metric=${metric}&${Q_RANGE}`, bearer(SECRETS.analyticsA)), h.deps);
    assert.equal(res.status, 400, metric);
  }
});

test("very large amounts sum exactly; malformed amounts are skipped and counted", () => {
  const blob = fixture();
  const huge = "123456789012345678901234567890";
  blob.agents!.intents.big1 = { ...(blob.agents!.intents.i4 as object), intentId: rid(301), amountBaseUnits: huge };
  blob.agents!.intents.big2 = { ...(blob.agents!.intents.i4 as object), intentId: rid(302), amountBaseUnits: huge };
  const out = buildOverview({ store: blob, merchant: A.address, nowSeconds: NOW, range: RANGE, sections: ["agents", "escrows"] });
  assert.equal(out.agents?.verifiedInRange.baseUnits, (2n * BigInt(huge) + 5_000_000n).toString());
  assert.equal(out.escrows?.malformed, 1);
  assert.equal(out.agents?.malformed, 1);
});

// ---------------------------------------------------------------------------
// Authentication and authorization
// ---------------------------------------------------------------------------

test("auth: missing, invalid, revoked, expired, missing scope, agent key, wallet", async () => {
  const h = harness();
  const path = `/api/v1/analytics/overview?${Q_RANGE}`;
  const status = async (headers: Record<string, string>) => (await analyticsOverview(get(path, headers), h.deps)).status;
  assert.equal(await status({}), 401);
  assert.equal(await status(bearer("final_live_" + "z".repeat(43))), 401);
  assert.equal(await status({ authorization: "Basic abc" }), 401);
  assert.equal(await status(bearer(SECRETS.revokedA)), 401);
  assert.equal(await status(bearer(SECRETS.expiredA)), 401);
  const other = await analyticsOverview(get(path, bearer(SECRETS.otherScopesA)), h.deps);
  assert.equal(other.status, 403, "every other scope combined does not imply analytics:read");
  assert.equal((other.body as Body).error.code, "forbidden");
  assert.equal(await status(bearer(SECRETS.agentA)), 401, "disabled agent key");
  for (const fn of [analyticsTimeseries, analyticsPolicies]) {
    const res = await fn(get(`/api/v1/analytics/x?${Q_RANGE}&metric=requests_created`.replace("&metric=requests_created", fn === analyticsTimeseries ? "&metric=requests_created" : ""), bearer(SECRETS.otherScopesA)), h.deps);
    assert.equal(res.status, 403);
  }
  assert.equal(await status(await walletHeaders(WALLET_ACTIONS.analyticsRead)), 200);
  assert.equal(await status(await walletHeaders(WALLET_ACTIONS.policiesList)), 401, "another wallet action is not accepted");
  assert.equal(await status(await walletHeaders(WALLET_ACTIONS.analyticsRead, B, A)), 401, "claimed merchant must be the signer");
});

test("an enabled agent-only key is denied analytics", async () => {
  const h = harness();
  const keys = apiKeys().map((k) => (k.id === "key_a_agent" ? { ...k, enabled: true } : k));
  h.deps.apiKeyAuth = { ...h.deps.apiKeyAuth, listKeys: async () => keys };
  const res = await analyticsOverview(get(`/api/v1/analytics/overview?${Q_RANGE}`, bearer(SECRETS.agentA)), h.deps);
  assert.equal(res.status, 403);
});

test("rate limit uses the existing API-key limiter", async () => {
  const h = harness();
  h.deps.apiKeyAuth = { ...h.deps.apiKeyAuth, rateLimitPerMinute: 1 };
  const path = `/api/v1/analytics/overview?${Q_RANGE}`;
  const secret = "final_live_" + "q".repeat(43);
  const keys = [keyRow(A.address, secret, ["analytics:read"], "key_rl_" + Date.now())];
  h.deps.apiKeyAuth = { ...h.deps.apiKeyAuth, listKeys: async () => keys };
  assert.equal((await analyticsOverview(get(path, bearer(secret)), h.deps)).status, 200);
  assert.equal((await analyticsOverview(get(path, bearer(secret)), h.deps)).status, 429);
});

// ---------------------------------------------------------------------------
// Storage and mutation
// ---------------------------------------------------------------------------

test("store read failure returns 503 store_unavailable", async () => {
  const h = harness({ readFails: true });
  for (const fn of [analyticsOverview, analyticsPolicies]) {
    const res = await fn(get(`/api/v1/analytics/x?${Q_RANGE}`, bearer(SECRETS.analyticsA)), h.deps);
    assert.equal(res.status, 503);
    assert.equal((res.body as Body).error.code, "store_unavailable");
  }
  const ts = await analyticsTimeseries(get(`/api/v1/analytics/timeseries?metric=requests_created&${Q_RANGE}`, bearer(SECRETS.analyticsA)), h.deps);
  assert.equal(ts.status, 503);
});

test("no mutation: deep-frozen store and byte-identical ledger across every handler", async () => {
  const h = harness();
  const snapshot = JSON.stringify(h.blob);
  deepFreeze(h.blob);
  const ledgerBefore = new Map(h.redis.values);
  const auth = bearer(SECRETS.analyticsA);
  const wallet = await walletHeaders(WALLET_ACTIONS.analyticsRead);
  const calls = [
    () => analyticsOverview(get(`/api/v1/analytics/overview?${Q_RANGE}`, auth), h.deps),
    () => analyticsOverview(get(`/api/v1/analytics/overview?${Q_RANGE}&sections=agents,policies`, wallet), h.deps),
    () => analyticsPolicies(get(`/api/v1/analytics/policies?${Q_RANGE}`, auth), h.deps),
    ...["requests_created", "requested_volume", "agent_verified", "agent_verified_volume", "policy_denials"].map(
      (m) => () => analyticsTimeseries(get(`/api/v1/analytics/timeseries?metric=${m}&${Q_RANGE}`, auth), h.deps),
    ),
  ];
  for (const call of calls) {
    const res = await call();
    assert.equal(res.status, 200);
    assert.equal(JSON.stringify(h.blob), snapshot);
    assert.deepEqual(new Map(h.redis.values), ledgerBefore);
  }
  assert.equal(h.commits, 0);
  assert.equal(h.redis.evalCalls, 0);
});

test("JSON backend: file store and single-instance file ledger are byte-identical after reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "final-analytics-"));
  const storePath = join(dir, "pay-store.json");
  const ledgerPath = join(dir, "policy-ledger.json");
  writeFileSync(storePath, JSON.stringify(fixture()));
  writeFileSync(ledgerPath, JSON.stringify({ [ledgerKey(A.address)]: JSON.stringify(ledgerDocA()) }));
  const storeBefore = readFileSync(storePath);
  const ledgerBefore = readFileSync(ledgerPath);
  const h = harness();
  const fileLedger = filePolicyLedger(ledgerPath);
  let commits = 0;
  h.deps.readBlob = async () => JSON.parse(readFileSync(storePath, "utf8")) as StoreFile;
  h.deps.ledger = { read: fileLedger.read, commit: async () => { commits += 1; return false; } } as unknown as AnalyticsDeps["ledger"];
  const pol = await analyticsPolicies(get(`/api/v1/analytics/policies?${Q_RANGE}`, bearer(SECRETS.analyticsA)), h.deps);
  assert.equal(pol.status, 200);
  assert.equal((pol.body as Body).sections.policies.utilization[0].committedBaseUnits, "7000000");
  const ov = await analyticsOverview(get(`/api/v1/analytics/overview?${Q_RANGE}`, bearer(SECRETS.analyticsA)), h.deps);
  assert.equal((ov.body as Body).sections.payments.total, 6);
  assert.deepEqual(readFileSync(storePath), storeBefore);
  assert.deepEqual(readFileSync(ledgerPath), ledgerBefore);
  assert.equal(commits, 0);
});

test("malformed ledger document is reported unavailable, not zero", async () => {
  const h = harness();
  h.redis.values.set(ledgerKey(A.address), "{not json");
  const res = await analyticsPolicies(get(`/api/v1/analytics/policies?${Q_RANGE}`, bearer(SECRETS.analyticsA)), h.deps);
  assert.equal(res.status, 200);
  assert.equal((res.body as Body).sections.policies.reservations.available, false);
  assert.equal(h.redis.values.get(ledgerKey(A.address)), "{not json");
});

test("malformed store sections are tolerated", () => {
  const blob = {
    records: { a: null, b: 5, c: { token: 7 } },
    agents: { intents: [1, 2], idempotency: {} },
    policies: { records: { x: { merchant: A.address, enabled: "yes" } }, reservations: {}, denials: { y: { merchant: A.address, reasons: "nope" } } },
    webhooks: { endpoints: null, deliveries: { z: { merchant: A.address, webhookId: "w", status: "weird", createdAt: "2027-01-10T00:00:00Z" } } },
    escrows: { records: "bad" },
    apiKeys: { keys: { k: "bad" } },
  } as unknown as StoreFile;
  const out = buildOverview({ store: blob, merchant: A.address, nowSeconds: NOW, range: RANGE, sections: ["payments", "agents", "policies", "webhooks", "escrows", "apiKeys"] });
  assert.equal(out.payments?.total, 0);
  assert.equal(out.policies?.malformed, 1);
  assert.equal(out.policies?.denials.malformed, 1);
  assert.equal(out.webhooks?.malformed, 1);
  assert.equal(out.escrows?.total, 0);
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

test("performance: ~10k payment records plus intents, denials, deliveries", async () => {
  const blob = fixture();
  const records = blob.records as Record<string, unknown>;
  const start = Date.parse("2026-12-01T00:00:00.000Z");
  for (let i = 0; i < 10_000; i += 1) {
    const created = new Date(start + i * 600_000).toISOString();
    if (i % 2 === 0) {
      const r = rec(encodePayRequest({ to: A.address, amount: String((i % 50) + 1), memo: `perf ${i}` }), created, i % 7 === 0 ? { paidTx: TX } : {});
      records[r.token] = r;
    } else {
      const r = rec(v2Token(A.address, rid(10_000 + i), BigInt((i % 90) + 1) * 1_000_000n, NOW + (i % 3 === 0 ? -100 : 3600)), created);
      records[r.token] = r;
      blob.agents!.intents[`perf${i}`] = {
        intentId: rid(50_000 + i),
        requestId: rid(10_000 + i),
        merchant: A.address,
        createdAt: created,
        status: i % 5 === 0 ? "VERIFIED" : "AWAITING_PAYMENT",
        verifiedAt: i % 5 === 0 ? Math.floor((start + i * 600_000) / 1000) + 60 : null,
        amountBaseUnits: String(((i % 90) + 1) * 1_000_000),
      };
    }
    if (i % 10 === 0) {
      blob.policies!.denials[`pd${i}`] = { merchant: A.address, evaluatedAt: Math.floor((start + i * 600_000) / 1000), reasons: [{ code: "AMOUNT_LIMIT_EXCEEDED", policyId: "pol_a1" }] };
      blob.webhooks!.deliveries[`pw${i}`] = dlv(`pw${i}`, "whA", A.address, 1, i % 20 === 0 ? "success" : "failed", 503);
    }
  }
  const h = harness({ blob });
  const range = "from=2026-11-01&to=2027-03-01";
  const t0 = performance.now();
  const ov = await analyticsOverview(get(`/api/v1/analytics/overview?${range}`, bearer(SECRETS.analyticsA)), h.deps);
  const t1 = performance.now();
  const ts = await analyticsTimeseries(get(`/api/v1/analytics/timeseries?metric=agent_verified_volume&${range}`, bearer(SECRETS.analyticsA)), h.deps);
  const t2 = performance.now();
  const pol = await analyticsPolicies(get(`/api/v1/analytics/policies?${range}`, bearer(SECRETS.analyticsA)), h.deps);
  const t3 = performance.now();
  assert.equal(ov.status, 200);
  assert.equal(ts.status, 200);
  assert.equal(pol.status, 200);
  assert.ok((ov.body as Body).sections.payments.total >= 10_000);
  assert.equal((ov.body as Body).sections.agents.created, 5_000 + 8);
  console.log(`analytics perf: overview ${(t1 - t0).toFixed(0)}ms, timeseries ${(t2 - t1).toFixed(0)}ms, policies ${(t3 - t2).toFixed(0)}ms`);
  assert.ok(t1 - t0 < 5_000, `overview took ${t1 - t0}ms`);
  assert.ok(t2 - t1 < 5_000);
  assert.ok(t3 - t2 < 5_000);
});

// ---------------------------------------------------------------------------
// Source boundary
// ---------------------------------------------------------------------------

test("analytics sources import no reconciliation, write, signing, chain, escrow, or webhook-emit paths", () => {
  const files = [
    "./analytics.ts",
    "./analyticsHttp.ts",
    "../app/api/v1/analytics/overview/route.ts",
    "../app/api/v1/analytics/timeseries/route.ts",
    "../app/api/v1/analytics/policies/route.ts",
  ];
  const banned = [
    "reconcilePaymentRecord", "markPaid", "markViewed", "upsertRecord", "findSettlementProof", "payStatusHttp", "loadReceipt", "reconcilePayment", "payPaid",
    "writePayStoreBlob", "mutatePayStoreBlob", ".commit(", "reserveSpendAtomically", "transitionReservation", "recoverReservations", "putDenial", "putReservation", "markReservation",
    "signTypedData", "signMessage", "sendTransaction", "writeContract", "privateKey", "PRIVATE_KEY", "createWalletClient",
    "createPublicClient", "verifyArcTransaction", "escrowProof", "fundEscrow", "releaseEscrow", "refundEscrow", "cancelEscrow",
    "emitWebhookEvent", "safeEmitWebhookEvent", "processDueWebhookDeliveries", "notifyWebhook",
    "getAgentPaymentIntent", "getAgentPaymentResult", "idempotency", "/api/pay", "statementGet",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const word of banned) assert.equal(source.includes(word), false, `${file}: ${word}`);
  }
});
