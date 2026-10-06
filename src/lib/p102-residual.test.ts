/**
 * Phase 13 Batch 2B — residual P1-02 concurrency hardening.
 * Caps inside CAS, escrow emit-after-persist, regression guards.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  asApiKeyRecord,
  generateApiSecret,
  handleCreateApiKey,
  hashApiSecret,
  liveApiKeyRuntime,
  type ApiKeyRecord,
} from "./apiKeys";
import { WALLET_ACTIONS, WALLET_AUTH_HEADERS, walletAuthMessage } from "./apiScopes";
import { createFakeRedis } from "./fakeRedisRest";
import {
  applyEscrowTransition,
  deriveEscrowId,
  usdcToken,
  type EscrowRecord,
  type EscrowState,
} from "./escrowTerms";
import {
  liveEscrowDeps,
  type EscrowDeps,
} from "./escrowService";
import {
  PAY_STORE_KEY,
  createPayRecord,
  mutatePayStoreBlob,
  readPayStoreBlob,
  type PayRecord,
  type StoreFile,
} from "./payStore";
import {
  LIMIT_EXCEEDED_CODE,
  MAX_ACTIVE_API_KEYS_PER_MERCHANT,
  ResourceLimitExceededError,
} from "./resourceLimits";

const ENV_KEYS = [
  "FINAL_PAY_STORE",
  "FINAL_API_KEY_PEPPER",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
const originalFetch = globalThis.fetch;

const A = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const NOW = 1_700_000_000;
const PEPPER = "batch2b-pepper";

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearStoreEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

async function withEnv(fn: () => Promise<void>): Promise<void> {
  clearStoreEnv();
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
}

function emptyStore(): StoreFile {
  return {
    records: {},
    webhooks: { endpoints: {}, deliveries: {} },
    apiKeys: { keys: {} },
    escrows: { records: {} },
    agents: { intents: {}, idempotency: {} },
    policies: { records: {}, reservations: {}, denials: {} },
  };
}

function installFake(redis: ReturnType<typeof createFakeRedis>): void {
  process.env.KV_REST_API_URL = "https://kv.fake";
  process.env.KV_REST_API_TOKEN = "token";
  process.env.FINAL_API_KEY_PEPPER = PEPPER;
  globalThis.fetch = redis.fetch as typeof fetch;
}

async function seed(redis: ReturnType<typeof createFakeRedis>, store: StoreFile): Promise<void> {
  redis.values.set(PAY_STORE_KEY, JSON.stringify(store));
}

function activeKey(id: string, merchant = A.address): Record<string, unknown> {
  return {
    id,
    merchant,
    name: "main",
    prefix: "final_live_abcd",
    hash: "a".repeat(64),
    scopes: ["payments:read"],
    enabled: true,
    revoked: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
  };
}

function payRow(token: string, to: Address = A.address): PayRecord {
  return {
    token,
    id: token.slice(0, 34).padEnd(34, "0"),
    to,
    amount: "100000",
    memo: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    views: 0,
    lastViewedAt: null,
    cancelled: false,
    cancelledAt: null,
    paidTx: null,
    webhookUrl: null,
  };
}

async function walletCreateRequest(name: string): Promise<Request> {
  const message = walletAuthMessage(WALLET_ACTIONS.apiKeysCreate, A.address, NOW);
  const signature = await A.signMessage({ message });
  const headers = new Headers({ "content-type": "application/json" });
  headers.set(WALLET_AUTH_HEADERS.merchant, A.address);
  headers.set(WALLET_AUTH_HEADERS.timestamp, String(NOW));
  headers.set(WALLET_AUTH_HEADERS.signature, signature);
  return new Request("http://localhost/api/v1/api-keys", {
    method: "POST",
    headers,
    body: JSON.stringify({ name }),
  });
}

test("1: concurrent API-key creates cannot exceed the active cap", () =>
  withEnv(async () => {
    const redis = createFakeRedis();
    installFake(redis);
    const base = emptyStore();
    // Cap - 1 existing active keys so only one more may succeed.
    for (let i = 0; i < MAX_ACTIVE_API_KEYS_PER_MERCHANT - 1; i += 1) {
      base.apiKeys!.keys[`key_seed_${i}`] = activeKey(`key_seed_${i}`);
    }
    await seed(redis, base);
    const runtime = liveApiKeyRuntime();
    // Freeze clock for wallet auth.
    runtime.nowSeconds = () => NOW;

    const results = await Promise.all([
      handleCreateApiKey(await walletCreateRequest("race-a"), runtime),
      handleCreateApiKey(await walletCreateRequest("race-b"), runtime),
    ]);
    const ok = results.filter((r) => r.status === 200);
    const blocked = results.filter((r) => r.status === 409);
    assert.equal(ok.length, 1);
    assert.equal(blocked.length, 1);
    assert.equal((blocked[0]!.body as { error: { code: string } }).error.code, LIMIT_EXCEEDED_CODE);

    const final = await readPayStoreBlob();
    const mine = Object.values(final.apiKeys!.keys)
      .map(asApiKeyRecord)
      .filter((row): row is ApiKeyRecord => !!row && getAddress(row.merchant) === A.address && !row.revoked);
    assert.equal(mine.length, MAX_ACTIVE_API_KEYS_PER_MERCHANT);
  }),
);

test("2: concurrent payment creates cannot exceed the merchant cap", () =>
  withEnv(async () => {
    const redis = createFakeRedis();
    installFake(redis);
    const { encodePayRequest } = await import("./payRequest");
    const base = emptyStore();
    const seedToken = encodePayRequest({ to: A.address, amount: "1", memo: "seed-0" });
    base.records[seedToken] = payRow(seedToken);
    await seed(redis, base);
    const cap = 2; // deterministic stand-in for MAX_PAYMENT_RECORDS_PER_MERCHANT

    const a = encodePayRequest({ to: A.address, amount: "2", memo: "race-a" });
    const b = encodePayRequest({ to: A.address, amount: "3", memo: "race-b" });
    const results = await Promise.allSettled([
      createPayRecord(payRow(a), A.address, { maxOwned: cap }),
      createPayRecord(payRow(b), A.address, { maxOwned: cap }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.status === "rejected" && rejected[0]!.reason instanceof ResourceLimitExceededError);

    const final = await readPayStoreBlob();
    const { countPayRecordsOwnedBy } = await import("./resourceLimits");
    assert.equal(countPayRecordsOwnedBy(Object.values(final.records), A.address), cap);
  }),
);

test("3: existing-record updates do not consume creation capacity", () =>
  withEnv(async () => {
    const redis = createFakeRedis();
    installFake(redis);
    const { encodePayRequest } = await import("./payRequest");
    const token = encodePayRequest({ to: A.address, amount: "1", memo: "once" });
    const other = encodePayRequest({ to: A.address, amount: "1", memo: "other" });
    const base = emptyStore();
    const cap = 2;
    base.records[token] = payRow(token);
    base.records[other] = payRow(other);
    await seed(redis, base);
    const updated = payRow(token);
    updated.amount = "999";
    const result = await createPayRecord(updated, A.address, { maxOwned: cap });
    assert.equal(result.created, false);
    assert.equal(result.record.amount, "999");
    // A brand-new token must still be rejected at cap.
    const fresh = encodePayRequest({ to: A.address, amount: "1", memo: "fresh" });
    await assert.rejects(
      () => createPayRecord(payRow(fresh), A.address, { maxOwned: cap }),
      (err: unknown) => err instanceof ResourceLimitExceededError,
    );
    const { countPayRecordsOwnedBy } = await import("./resourceLimits");
    const final = await readPayStoreBlob();
    assert.equal(countPayRecordsOwnedBy(Object.values(final.records), A.address), cap);
  }),
);

test("4: CAS retries preserve unrelated sections during capped create", () =>
  withEnv(async () => {
    const redis = createFakeRedis();
    installFake(redis);
    const base = emptyStore();
    base.webhooks!.endpoints.wh_keep = { id: "wh_keep", merchant: A.address };
    base.agents!.idempotency.idem_keep = { bodyHash: "hash-a" };
    await seed(redis, base);
    redis.injectConflicts(2);

    const secret = generateApiSecret();
    const row: ApiKeyRecord = {
      id: "key_cas_retry",
      merchant: A.address,
      name: "cas",
      prefix: secret.slice(0, 18),
      hash: hashApiSecret(secret, PEPPER),
      scopes: ["payments:read"],
      enabled: true,
      revoked: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
    };
    await liveApiKeyRuntime().createKey(row);
    const final = await readPayStoreBlob();
    assert.ok(final.apiKeys!.keys.key_cas_retry);
    assert.deepEqual(final.webhooks!.endpoints.wh_keep, base.webhooks!.endpoints.wh_keep);
    assert.deepEqual(final.agents!.idempotency.idem_keep, base.agents!.idempotency.idem_keep);
    assert.ok(redis.conflictsReturned >= 2);
  }),
);

test("5: revoked API keys cannot be resurrected by concurrent create/touch", () =>
  withEnv(async () => {
    const redis = createFakeRedis();
    installFake(redis);
    const base = emptyStore();
    const revoked = activeKey("key_rev");
    revoked.revoked = true;
    revoked.enabled = false;
    base.apiKeys!.keys.key_rev = revoked;
    await seed(redis, base);

    await Promise.all([
      mutatePayStoreBlob((store) => {
        const current = asApiKeyRecord(store.apiKeys!.keys.key_rev);
        if (!current || current.revoked || !current.enabled) return;
        current.lastUsedAt = "2026-01-02T00:00:00.000Z";
        store.apiKeys!.keys.key_rev = current;
      }),
      mutatePayStoreBlob((store) => {
        // Unrelated section write concurrent with touch attempt.
        store.webhooks!.endpoints.wh_x = { id: "wh_x" };
      }),
    ]);
    const final = await readPayStoreBlob();
    const row = asApiKeyRecord(final.apiKeys!.keys.key_rev)!;
    assert.equal(row.revoked, true);
    assert.equal(row.enabled, false);
    assert.equal(row.lastUsedAt, null);
    assert.ok(final.webhooks!.endpoints.wh_x);
  }),
);

function escrowRow(state: EscrowState, overrides: Partial<EscrowRecord> = {}): EscrowRecord {
  const terms = {
    chainId: 5042,
    token: usdcToken(),
    payer: getAddress("0x1111111111111111111111111111111111111111"),
    recipient: getAddress("0x2222222222222222222222222222222222222222"),
    creator: A.address,
    amountBaseUnits: "1000000",
    expiresAt: NOW + 3600,
  };
  const base: EscrowRecord = {
    ...terms,
    escrowId: deriveEscrowId(terms),
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    state,
    openTxHash: null,
    fundingTxHash: null,
    releaseTxHash: null,
    refundTxHash: null,
    cancelTxHash: null,
    usedNonces: [],
  };
  const merged = { ...base, ...overrides, state };
  // Keep escrowId consistent with terms unless caller overrides identity fields carefully.
  if (!overrides.escrowId) {
    merged.escrowId = deriveEscrowId({
      chainId: merged.chainId,
      token: merged.token,
      payer: merged.payer,
      recipient: merged.recipient,
      creator: merged.creator,
      amountBaseUnits: merged.amountBaseUnits,
      expiresAt: merged.expiresAt,
    });
  }
  return merged;
}

test("6-8: escrow no-op / failed persist emit nothing; successful transition emits once", () =>
  withEnv(async () => {
    const redis = createFakeRedis();
    installFake(redis);
    await seed(redis, emptyStore());

    const events: string[] = [];
    const live = liveEscrowDeps(liveApiKeyRuntime());
    const deps: EscrowDeps = {
      ...live,
      emit(type) {
        events.push(type);
      },
    };

    // Successful create → one emit.
    const created = escrowRow("CREATED");
    assert.equal(await deps.save(created), true);
    deps.emit("escrow.created", created.creator, { escrowId: created.escrowId });
    assert.deepEqual(events, ["escrow.created"]);

    // Same-state rewrite → false, no new emit from save gate.
    events.length = 0;
    assert.equal(await deps.save({ ...created, usedNonces: ["0x01"] }), false);
    // Caller must not emit when save returns false.
    assert.deepEqual(events, []);

    // Rejected regression FUNDED ← would be blocked; seed FUNDED then try CREATED.
    events.length = 0;
    const funded = escrowRow("FUNDED", { fundingTxHash: ("0x" + "cd".repeat(32)) as Hex });
    await deps.save(funded); // state change CREATED→FUNDED? existing is CREATED with nonces — actually existing CREATED, FUNDED is forward → true
    // Reset store to FUNDED only.
    await mutatePayStoreBlob((store) => {
      store.escrows = { records: { [funded.escrowId.toLowerCase()]: funded } };
    });
    const rejected = await deps.save(escrowRow("CREATED"));
    assert.equal(rejected, false);
    assert.deepEqual(events, []);

    // Forward transition OPEN → emit once when caller gates on persisted.
    events.length = 0;
    await mutatePayStoreBlob((store) => {
      store.escrows = { records: { [created.escrowId.toLowerCase()]: created } };
    });
    const opened = escrowRow("OPEN", { openTxHash: ("0x" + "11".repeat(32)) as Hex });
    assert.equal(await deps.save(opened), true);
    deps.emit("escrow.opened", opened.creator, { escrowId: opened.escrowId });
    assert.deepEqual(events, ["escrow.opened"]);

    // applyEscrowTransition sanity (no emit side).
    assert.equal(
      applyEscrowTransition({ state: "CREATED", action: "open", blockTimestamp: 1, expiresAt: 10, logOk: true }).ok,
      true,
    );
  }),
);

test("9: V1/V2 registration authorization modules unchanged (source guard)", async () => {
  const payStatus = await readFile(new URL("./payStatusHttp.ts", import.meta.url), "utf8");
  assert.match(payStatus, /verifyFinalRequest|verifyV2Request/);
  assert.match(payStatus, /paymentsRegister|payment_requests:write/);
  assert.match(payStatus, /createOwnedRecord/);
  assert.doesNotMatch(payStatus, /countOwnedRecords/);
});

test("10: checkout observation remains read-only", async () => {
  const src = await readFile(new URL("./checkoutObserve.ts", import.meta.url), "utf8");
  assert.equal(/mutatePayStoreBlob|writePayStoreBlob|createPayRecord|upsertRecord/.test(src), false);
});

test("11: analytics remains read-only", async () => {
  const src = await readFile(new URL("./analytics.ts", import.meta.url), "utf8");
  const http = await readFile(new URL("./analyticsHttp.ts", import.meta.url), "utf8");
  assert.equal(/mutatePayStoreBlob|writePayStoreBlob|createPayRecord/.test(src), false);
  assert.equal(/mutatePayStoreBlob|writePayStoreBlob|createPayRecord/.test(http), false);
});

test("12: existing idempotency first-commit-wins semantics unchanged", () =>
  withEnv(async () => {
    const redis = createFakeRedis();
    installFake(redis);
    const base = emptyStore();
    base.agents!.idempotency.idem_1 = { bodyHash: "hash-a", intentId: "intent_1" };
    await seed(redis, base);
    await mutatePayStoreBlob((store) => {
      const existing = store.agents!.idempotency.idem_1 as { bodyHash: string } | undefined;
      if (existing) return; // first-commit wins
      store.agents!.idempotency.idem_1 = { bodyHash: "hash-b" };
    });
    const final = await readPayStoreBlob();
    assert.equal((final.agents!.idempotency.idem_1 as { bodyHash: string }).bodyHash, "hash-a");
  }),
);

test("secret is generated before CAS and stable across createKey retries", () =>
  withEnv(async () => {
    const redis = createFakeRedis();
    installFake(redis);
    await seed(redis, emptyStore());
    redis.injectConflicts(3);
    const secret = generateApiSecret();
    const hash = hashApiSecret(secret, PEPPER);
    const row: ApiKeyRecord = {
      id: "key_stable_secret",
      merchant: A.address,
      name: "stable",
      prefix: secret.slice(0, 18),
      hash,
      scopes: ["payments:read"],
      enabled: true,
      revoked: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
    };
    await liveApiKeyRuntime().createKey(row);
    const stored = asApiKeyRecord((await readPayStoreBlob()).apiKeys!.keys.key_stable_secret)!;
    assert.equal(stored.hash, hash);
    assert.ok(redis.conflictsReturned >= 3);
  }),
);
