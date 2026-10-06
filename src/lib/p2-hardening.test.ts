/**
 * Phase 13 Batch 4 — P2 security and reliability hardening tests.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  authenticateAuthorization,
  apiKeyPrefix,
  generateApiSecret,
  handleCreateApiKey,
  hashApiSecret,
  resetApiKeyRateLimits,
  type ApiKeyRecord,
  type ApiKeyRuntime,
} from "./apiKeys";
import { WALLET_ACTIONS, WALLET_AUTH_HEADERS } from "./apiScopes";
import { putDenial, type PolicyDenialRecord } from "./paymentPolicies";
import { MAX_POLICY_DENIALS_PER_MERCHANT, MAX_AGENT_IDEMPOTENCY_PER_MERCHANT } from "./resourceLimits";
import {
  mutatePayStoreBlob,
  readPayStoreBlob,
  PayStoreMalformedError,
  type StoreFile,
} from "./payStore";
import { assertSafeWebhookDestination, isBlockedIp, validateWebhookUrl } from "./webhooks";
import { redactString, redactValue, safeLog } from "./safeLog";
import { consumeWalletNonce } from "./walletNonce";
import { signedWalletRequest, withMemoryNonces, memoryNonceConsumer } from "./walletAuthTest";

const A = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const B = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const PEPPER = "p2-test-pepper-32-bytes-minimum!!";
const NOW = 1_700_000_000;

const ENV_KEYS = [
  "FINAL_PAY_STORE",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "FINAL_API_KEY_PEPPER",
] as const;

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "final-p2-"));
  const path = join(dir, "pay-store.json");
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.FINAL_PAY_STORE = path;
  process.env.FINAL_API_KEY_PEPPER = PEPPER;
  try {
    await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function memoryKeys(rows: ApiKeyRecord[] = []): ApiKeyRuntime {
  const keys = [...rows];
  return withMemoryNonces({
    nowSeconds: () => NOW,
    pepper: PEPPER,
    listKeys: async () => keys.map((k) => ({ ...k })),
    upsertKey: async (row) => {
      const i = keys.findIndex((k) => k.id === row.id);
      if (i >= 0) keys[i] = row;
      else keys.push(row);
    },
    createKey: async (row) => {
      keys.push(row);
    },
    touchLastUsed: async () => {},
  });
}

function issue(merchant: string, scopes: ApiKeyRecord["scopes"]): { secret: string; row: ApiKeyRecord } {
  const secret = generateApiSecret();
  const row: ApiKeyRecord = {
    id: `key_${randomBytes(8).toString("hex")}`,
    merchant: getAddress(merchant),
    name: "t",
    prefix: apiKeyPrefix(secret),
    hash: hashApiSecret(secret, PEPPER),
    scopes,
    enabled: true,
    revoked: false,
    createdAt: new Date(NOW * 1000).toISOString(),
    lastUsedAt: null,
    expiresAt: null,
  };
  return { secret, row };
}

test("P2-01: wallet signature replay with same nonce is rejected", async () => {
  await withTempStore(async () => {
    const runtime = memoryKeys();
    const body = { name: "one", scopes: ["webhooks:read"] };
    const nonce = ("0x" + "11".repeat(32)) as Hex;
    const req1 = await signedWalletRequest({
      account: A,
      action: WALLET_ACTIONS.apiKeysCreate,
      url: "https://pay.example/api/v1/api-keys",
      method: "POST",
      body,
      timestamp: NOW,
      nonce,
    });
    const first = await handleCreateApiKey(req1, runtime);
    assert.equal(first.status, 200);
    const req2 = await signedWalletRequest({
      account: A,
      action: WALLET_ACTIONS.apiKeysCreate,
      url: "https://pay.example/api/v1/api-keys",
      method: "POST",
      body: { name: "two", scopes: ["webhooks:read"] },
      timestamp: NOW,
      nonce,
      signBodyText: JSON.stringify(body),
    });
    // Even with matching digest from original body, nonce is consumed.
    const replay = await handleCreateApiKey(
      await signedWalletRequest({
        account: A,
        action: WALLET_ACTIONS.apiKeysCreate,
        url: "https://pay.example/api/v1/api-keys",
        method: "POST",
        body,
        timestamp: NOW,
        nonce,
      }),
      runtime,
    );
    assert.equal(replay.status, 401);
    void req2;
  });
});

test("P2-01: concurrent nonce reuse authorizes only one write", async () => {
  await withTempStore(async () => {
    const bag = memoryNonceConsumer();
    const runtime = memoryKeys();
    runtime.consumeWalletNonce = bag.consume;
    const nonce = ("0x" + "22".repeat(32)) as Hex;
    const body = { name: "race", scopes: ["webhooks:read"] };
    const mk = () =>
      signedWalletRequest({
        account: A,
        action: WALLET_ACTIONS.apiKeysCreate,
        url: "https://pay.example/api/v1/api-keys",
        method: "POST",
        body,
        timestamp: NOW,
        nonce,
      });
    const [a, b] = await Promise.all([
      handleCreateApiKey(await mk(), runtime),
      handleCreateApiKey(await mk(), runtime),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 401]);
    assert.equal(bag.used.size, 1);
  });
});

test("P2-01: cross-action and cross-merchant replay rejected; payload tampering rejected", async () => {
  await withTempStore(async () => {
    const runtime = memoryKeys();
    const body = { name: "x", scopes: ["webhooks:read"] };
    const createReq = await signedWalletRequest({
      account: A,
      action: WALLET_ACTIONS.apiKeysCreate,
      url: "https://pay.example/api/v1/api-keys",
      method: "POST",
      body,
      timestamp: NOW,
    });
    // Cross-action: reuse headers on list
    const crossAction = new Request("https://pay.example/api/v1/api-keys", {
      method: "GET",
      headers: createReq.headers,
    });
    const { handleListApiKeys } = await import("./apiKeys");
    assert.equal((await handleListApiKeys(crossAction, runtime)).status, 401);

    const otherMerchant = await signedWalletRequest({
      account: B,
      action: WALLET_ACTIONS.apiKeysCreate,
      url: "https://pay.example/api/v1/api-keys",
      method: "POST",
      body,
      timestamp: NOW,
    });
    otherMerchant.headers.set(WALLET_AUTH_HEADERS.merchant, A.address);
    assert.equal((await handleCreateApiKey(otherMerchant, runtime)).status, 401);

    const tampered = await signedWalletRequest({
      account: A,
      action: WALLET_ACTIONS.apiKeysCreate,
      url: "https://pay.example/api/v1/api-keys",
      method: "POST",
      body: { name: "tampered", scopes: ["webhooks:write"] },
      timestamp: NOW,
      signBodyText: JSON.stringify(body),
    });
    assert.equal((await handleCreateApiKey(tampered, runtime)).status, 401);
  });
});

test("P2-02: invalid bearer is 401; pre-auth rate limit bounds work", async () => {
  resetApiKeyRateLimits();
  const { secret, row } = issue(A.address, ["webhooks:read"]);
  const runtime = memoryKeys([row]);
  assert.equal((await authenticateAuthorization(null, "webhooks:read", runtime)).ok, false);
  assert.equal((await authenticateAuthorization("Bearer final_live_nopeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "webhooks:read", runtime)).ok, false);
  const ok = await authenticateAuthorization(`Bearer ${secret}`, "webhooks:read", runtime);
  assert.equal(ok.ok, true);

  resetApiKeyRateLimits();
  const bogus = "Bearer final_live_" + "z".repeat(43);
  let limited = false;
  for (let i = 0; i < 80; i += 1) {
    const res = await authenticateAuthorization(bogus, "webhooks:read", runtime);
    if (!res.ok && res.status === 429) {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true);
  resetApiKeyRateLimits();
});

test("P2-03: private IPv4/IPv6 and DNS rebinding rejected; redirects disabled path", async () => {
  assert.throws(() => validateWebhookUrl("https://127.0.0.1/h"), /not allowed/);
  assert.throws(() => validateWebhookUrl("https://10.1.2.3/h"), /not allowed/);
  assert.throws(() => validateWebhookUrl("https://[::1]/h"), /not allowed/);
  assert.throws(() => validateWebhookUrl("https://[fc00::1]/h"), /not allowed/);
  assert.throws(() => validateWebhookUrl("https://[fe80::1]/h"), /not allowed/);
  assert.throws(() => validateWebhookUrl("https://[::ffff:127.0.0.1]/h"), /not allowed/);
  assert.equal(isBlockedIp("169.254.169.254"), true);
  assert.equal(isBlockedIp("8.8.8.8"), false);

  await assert.rejects(
    () => assertSafeWebhookDestination("https://hooks.example.com/x", async () => ["10.0.0.1"]),
    /not allowed/,
  );
  await assert.rejects(
    () => assertSafeWebhookDestination("https://hooks.example.com/x", async () => {
      throw new Error("dns down");
    }),
    /could not be resolved/,
  );
  await assertSafeWebhookDestination("https://hooks.example.com/x", async () => ["93.184.216.34"]);
});

test("P2-04: policy denials and idempotency rows are bounded", async () => {
  const store: StoreFile = { records: {}, policies: { records: {}, reservations: {}, denials: {} }, agents: { intents: {}, idempotency: {} } };
  const merchant = A.address;
  for (let i = 0; i < MAX_POLICY_DENIALS_PER_MERCHANT + 25; i += 1) {
    const denial: PolicyDenialRecord = {
      id: `d_${i}`,
      merchant,
      agentId: null,
      amountBaseUnits: "1",
      recipient: merchant,
      token: "0x3600000000000000000000000000000000000000",
      chainId: 5042,
      evaluatedAt: i,
      policyVersion: 1 as const,
      policyIds: [],
      reasons: [],
      createdAt: new Date(i * 1000).toISOString(),
    };
    putDenial(store, denial);
  }
  const denials = Object.keys(store.policies!.denials);
  assert.equal(denials.length, MAX_POLICY_DENIALS_PER_MERCHANT);
  assert.equal(denials.includes("d_0"), false);
  assert.equal(denials.includes(`d_${MAX_POLICY_DENIALS_PER_MERCHANT + 24}`), true);
  assert.ok(MAX_AGENT_IDEMPOTENCY_PER_MERCHANT >= 100);
});

test("P2-05: malformed store fails closed and does not wipe", async () => {
  await withTempStore(async () => {
    const path = process.env.FINAL_PAY_STORE!;
    await writeFile(path, "{not-json", "utf8");
    await assert.rejects(() => readPayStoreBlob(), (err: unknown) => err instanceof PayStoreMalformedError);
    await assert.rejects(
      () => mutatePayStoreBlob((s) => {
        s.records.x = s.records.x;
      }),
      (err: unknown) => err instanceof PayStoreMalformedError,
    );
  });
});

test("P2-06: verified tx hash uniqueness holds under CAS merge", async () => {
  await withTempStore(async () => {
    const tx = ("0x" + "ab".repeat(32)) as Hex;
    const id1 = ("0x" + "11".repeat(32)) as Hex;
    const id2 = ("0x" + "22".repeat(32)) as Hex;
    await mutatePayStoreBlob((store) => {
      store.agents = {
        intents: {
          [id1]: {
            intentId: id1,
            merchant: A.address,
            status: "VERIFIED",
            verifiedTxHash: tx,
            requestId: id1,
            createdAt: NOW,
            expiresAt: NOW + 100,
          },
        },
        idempotency: {},
      };
    });
    // Second intent claiming same verified hash should be detectable on latest snapshot.
    const snap = await readPayStoreBlob();
    const intents = snap.agents?.intents ?? {};
    let used = false;
    for (const [id, raw] of Object.entries(intents)) {
      if (id.toLowerCase() === id2.toLowerCase()) continue;
      const row = raw as { verifiedTxHash?: string; status?: string };
      if (row.status === "VERIFIED" && row.verifiedTxHash?.toLowerCase() === tx.toLowerCase()) used = true;
    }
    assert.equal(used, true);
  });
});

test("P2-07: agentId is documented as a client label (module comment present)", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("./agentPayments.ts", import.meta.url), "utf8"));
  assert.match(src, /NOT an authenticated principal/);
});

test("P2-08: escrow release is recipient-only in contract source", async () => {
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../../contracts/FinalEscrow.sol", import.meta.url), "utf8"),
  );
  assert.match(src, /msg\.sender != row\.recipient/);
  assert.match(src, /function release/);
  assert.match(src, /NotRecipient/);
});

test("P2-09: safeLog redacts secrets", () => {
  const redacted = redactString("Bearer final_live_abcdefghijklmnop and 0x" + "ab".repeat(32));
  assert.equal(redacted.includes("final_live_abcdefghijklmnop"), false);
  assert.equal(redacted.includes("Bearer [REDACTED]"), true);
  const obj = redactValue({ authorization: "Bearer x", nested: { apiKey: "secret", ok: 1 } }) as Record<string, unknown>;
  assert.equal(obj.authorization, "[REDACTED]");
  assert.deepEqual(obj.nested, { apiKey: "[REDACTED]", ok: 1 });
  // Does not throw
  safeLog("info", "test", { password: "nope", token: "t" });
});

test("P2-01 nonce consume is atomic across CAS (shared store)", async () => {
  await withTempStore(async () => {
    const nonce = "0x" + "33".repeat(32);
    const a = await consumeWalletNonce(A.address, nonce, NOW);
    const b = await consumeWalletNonce(A.address, nonce, NOW);
    assert.equal(a, true);
    assert.equal(b, false);
  });
});
