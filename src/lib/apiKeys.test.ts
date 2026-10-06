import { randomBytes as webhookTestKeyBytes } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAddress, type Address, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AUTH_MESSAGE,
  authenticateAuthorization,
  generateApiSecret,
  handleCreateApiKey,
  handleDeleteApiKey,
  handleGetApiKey,
  handleListApiKeys,
  handleRotateApiKey,
  hashApiSecret,
  liveApiKeyRuntime,
  resetApiKeyRateLimits,
  resetApiKeyUseThrottle,
  toPublicApiKey,
  type ApiKeyRecord,
  type ApiKeyRuntime,
} from "./apiKeys";
import { API_SCOPES, DEFAULT_API_KEY_SCOPES, WALLET_ACTIONS, WALLET_AUTH_HEADERS, type ApiScope } from "./apiScopes";
import { signedWalletRequest, withMemoryNonces } from "./walletAuthTest";
import {
  API_ERROR_CODES,
  createPaymentRequest,
  getPaymentRequest,
  verifyTransaction,
  type DeveloperApiDeps,
} from "./developerApi";
import { signFinalRequest, validateFinalRequest } from "./finalRequest";
import type { LoadedReceipt } from "./loadReceipt";
import { encodeV2PayRequest } from "./payRequest";
import { getRecord, upsertRecord, type PayRecord } from "./payStore";
import {
  MAX_ACTIVE_API_KEYS_PER_MERCHANT,
  MAX_PAYMENT_RECORDS_PER_MERCHANT,
  MAX_STORED_API_KEYS_PER_MERCHANT,
  ResourceLimitExceededError,
  countPayRecordsOwnedBy,
} from "./resourceLimits";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpoint,
  sendWebhookTest,
  updateWebhookEndpoint,
  type WebhookDeps,
} from "./webhooks";

// P3-06: webhook secrets are encrypted at rest; tests use a random per-run key (never a real key).
process.env.FINAL_WEBHOOK_ENCRYPTION_KEY = webhookTestKeyBytes(32).toString("hex");

const PEPPER = "phase5-test-pepper";
const A = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const B = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const NOW = 1_700_000_000;
const REQUEST_ID = ("0x" + "11".repeat(16)) as Hex;
const NONCE = ("0x" + "22".repeat(32)) as Hex;
const TX = ("0x" + "ab".repeat(32)) as Hash;

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

function issue(merchant: Address, scopes: readonly ApiScope[] = DEFAULT_API_KEY_SCOPES, name = "desk") {
  const secret = generateApiSecret();
  const row: ApiKeyRecord = {
    id: `key_${secret.slice(-12)}`,
    merchant,
    name,
    prefix: secret.slice(0, "final_live_".length + 8),
    hash: hashApiSecret(secret, PEPPER),
    scopes: [...scopes],
    enabled: true,
    revoked: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
  };
  return { secret, row };
}

function memoryRuntime(seed: ApiKeyRecord[] = [], now = NOW) {
  const keys = seed.map((row) => ({ ...row, scopes: [...row.scopes] }));
  const clock = { value: now };
  let touches = 0;
  const runtime: ApiKeyRuntime = {
    nowSeconds: () => clock.value,
    pepper: PEPPER,
    listKeys: async () => keys.map((row) => ({ ...row, scopes: [...row.scopes] })),
    upsertKey: async (row) => {
      const index = keys.findIndex((key) => key.id === row.id);
      if (index >= 0) keys[index] = { ...row, scopes: [...row.scopes] };
      else keys.push({ ...row, scopes: [...row.scopes] });
    },
    createKey: async (row) => {
      const merchant = getAddress(row.merchant);
      const mine = keys.filter((key) => getAddress(key.merchant) === merchant);
      if (mine.filter((key) => !key.revoked).length >= MAX_ACTIVE_API_KEYS_PER_MERCHANT) {
        throw new ResourceLimitExceededError("Active API key limit reached. Revoke an unused key first.");
      }
      if (mine.length >= MAX_STORED_API_KEYS_PER_MERCHANT) {
        throw new ResourceLimitExceededError("API key limit reached for this merchant.");
      }
      keys.push({ ...row, scopes: [...row.scopes] });
    },
    touchLastUsed: async (id, iso) => {
      touches += 1;
      const row = keys.find((key) => key.id === id);
      if (row) row.lastUsedAt = iso;
    },
  };
  return { runtime: withMemoryNonces(runtime), keys, clock, touches: () => touches };
}

function bearer(secret: string): string {
  return `Bearer ${secret}`;
}

function errorOf(body: unknown): { code: string; message: string } {
  const record = body as { error: { code: string; message: string } };
  assert.equal(typeof record.error.code, "string");
  assert.equal(typeof record.error.message, "string");
  return record.error;
}

async function walletRequest(account: typeof A, action: string, url: string, body?: unknown): Promise<Request> {
  return signedWalletRequest({
    account,
    action,
    url,
    body,
    timestamp: NOW,
    method: body === undefined ? "GET" : "POST",
  });
}

function payDeps(runtime: ApiKeyRuntime, authorization: string | null, rows: PayRecord[]): DeveloperApiDeps {
  return {
    nowSeconds: () => runtime.nowSeconds(),
    origin: "https://pay.example",
    authorization,
    apiKeyAuth: runtime,
    upsertRecord: async (record) => {
      const index = rows.findIndex((row) => row.token === record.token);
      if (index >= 0) rows[index] = record;
      else rows.push(record);
      return record;
    },
    createOwnedRecord: async (record, owner) => {
      const index = rows.findIndex((row) => row.token === record.token);
      if (index >= 0) {
        rows[index] = record;
        return { record, created: false };
      }
      if (countPayRecordsOwnedBy(rows, owner) >= MAX_PAYMENT_RECORDS_PER_MERCHANT) {
        throw new ResourceLimitExceededError("Payment request limit reached for this merchant.");
      }
      rows.push(record);
      return { record, created: true };
    },
    listRecords: async () => rows.slice(),
    loadReceipt: async () => ({ error: "Transaction not found on Arc mainnet.", status: 404 }),
  };
}

function webhookDeps(caller?: Address): WebhookDeps {
  let seq = 0;
  return {
    nowSeconds: () => NOW,
    caller,
    randomId: (prefix) => `${prefix}_${(++seq).toString(16).padStart(4, "0")}`,
    createSecret: () => `whsec_${seq}`,
    fetch: async () => new Response(null, { status: 200 }),
  };
}

async function withFile(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "final-api-keys-"));
  const path = join(dir, "pay-store.json");
  clearStoreEnv();
  process.env.FINAL_PAY_STORE = path;
  await writeFile(path, JSON.stringify({ records: {} }));
  try {
    await fn(path);
  } finally {
    restoreEnv();
    await rm(dir, { recursive: true, force: true });
  }
}

test("missing API key is 401", async () => {
  const { runtime } = memoryRuntime();
  const result = await authenticateAuthorization(null, "payment_requests:read", runtime);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 401);
  assert.equal(result.code, "unauthorized");
  assert.equal(result.message, AUTH_MESSAGE);
});

test("malformed Authorization header is 401 and does not reveal a key id", async () => {
  const { secret, row } = issue(A.address, API_SCOPES);
  const { runtime } = memoryRuntime([row]);
  for (const header of ["Basic final_live_nope", "Bearer", "final_live_raw", "Bearer final_live_a final_live_b"]) {
    const result = await authenticateAuthorization(header, "payment_requests:read", runtime);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.message, AUTH_MESSAGE);
    assert.equal(result.message.includes(row.id), false);
    assert.equal(result.message.includes(secret), false);
  }
});

test("invalid API key is the same 401 as a missing key", async () => {
  const { row } = issue(A.address, API_SCOPES);
  const { runtime } = memoryRuntime([row]);
  const result = await authenticateAuthorization(bearer(generateApiSecret()), "payment_requests:read", runtime);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 401);
  assert.equal(result.message, AUTH_MESSAGE);
});

test("revoked API key is the same 401 and does not say the key exists", async () => {
  const { secret, row } = issue(A.address, API_SCOPES);
  row.revoked = true;
  row.enabled = false;
  const { runtime } = memoryRuntime([row]);
  const result = await authenticateAuthorization(bearer(secret), "payment_requests:read", runtime);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.message, AUTH_MESSAGE);
  assert.equal(JSON.stringify(result).includes(row.id), false);
});

test("a valid API key authenticates as its stored merchant", async () => {
  const { secret, row } = issue(A.address, ["payment_requests:read"]);
  const { runtime } = memoryRuntime([row]);
  const result = await authenticateAuthorization(bearer(secret), "payment_requests:read", runtime);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.merchant, getAddress(A.address));
  assert.equal(result.keyId, row.id);
});

test("merchant A cannot read merchant B payment requests", async () => {
  const keyA = issue(A.address, ["payment_requests:read", "payment_requests:write"]);
  const keyB = issue(B.address, ["payment_requests:read", "payment_requests:write"]);
  const rows: PayRecord[] = [];
  const runtime = memoryRuntime([keyA.row, keyB.row]).runtime;
  const fields = validateFinalRequest({
    version: 2,
    requestId: REQUEST_ID,
    merchant: B.address,
    recipient: B.address,
    amountBaseUnits: 1_000_000n,
    memo: "B-ONLY",
    chainId: 5042,
    expiresAt: NOW + 10_000,
    nonce: NONCE,
  });
  const signed = await signFinalRequest(fields, B);
  const created = await createPaymentRequest(
    new Request("https://pay.example/api/v1/payment-requests", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: bearer(keyB.secret) },
      body: JSON.stringify({
        requestId: signed.requestId,
        merchant: signed.merchant,
        recipient: signed.recipient,
        amountBaseUnits: signed.amountBaseUnits.toString(),
        memo: signed.memo,
        chainId: signed.chainId,
        expiresAt: signed.expiresAt,
        nonce: signed.nonce,
        signature: signed.signature,
      }),
    }),
    payDeps(runtime, bearer(keyB.secret), rows),
  );
  assert.equal(created.status, 200);
  const denied = await getPaymentRequest(REQUEST_ID, payDeps(runtime, bearer(keyA.secret), rows));
  assert.equal(denied.status, 404);
  assert.equal(errorOf(denied.body).code, "not_found");
  assert.equal(JSON.stringify(denied.body).includes("B-ONLY"), false);
  const allowed = await getPaymentRequest(REQUEST_ID, payDeps(runtime, bearer(keyB.secret), rows));
  assert.equal(allowed.status, 200);
});

test("merchant A cannot get, update, delete, or test merchant B webhooks", async () => {
  await withFile(async () => {
    const created = await createWebhookEndpoint(
      { merchant: B.address, url: "https://hooks.example.com/b", events: ["webhook.test"] },
      webhookDeps(B.address),
    );
    assert.equal(created.status, 200);
    const id = (created.body as { id: string }).id;
    const asA = webhookDeps(A.address);
    assert.equal((await getWebhookEndpoint(id, A.address, asA)).status, 404);
    assert.equal((await updateWebhookEndpoint(id, { merchant: A.address, enabled: false }, asA)).status, 404);
    assert.equal((await deleteWebhookEndpoint(id, A.address, asA)).status, 404);
    assert.equal((await sendWebhookTest(id, A.address, asA)).status, 404);
    const still = await getWebhookEndpoint(id, B.address, webhookDeps(B.address));
    assert.equal(still.status, 200);
    assert.equal((still.body as { enabled: boolean }).enabled, true);
  });
});

test("correct scope succeeds and a missing scope is 403", async () => {
  const { secret, row } = issue(A.address, ["payment_requests:read"]);
  const { runtime } = memoryRuntime([row]);
  const ok = await authenticateAuthorization(bearer(secret), "payment_requests:read", runtime);
  assert.equal(ok.ok, true);
  const denied = await authenticateAuthorization(bearer(secret), "payment_requests:write", runtime);
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "forbidden");
  assert.equal(denied.message, "Missing required scope.");
});

test("secret is returned only on create and is absent from later reads", async () => {
  const { runtime, keys } = memoryRuntime();
  const request = await walletRequest(A, WALLET_ACTIONS.apiKeysCreate, "https://pay.example/api/v1/api-keys", {
    name: "ledger",
  });
  const created = await handleCreateApiKey(request, runtime);
  assert.equal(created.status, 200);
  const body = created.body as { secret?: string; id: string; prefix: string; scopes: string[] };
  assert.equal(typeof body.secret, "string");
  assert.equal(body.secret?.startsWith("final_live_"), true);
  assert.deepEqual(body.scopes, [...DEFAULT_API_KEY_SCOPES]);
  assert.equal(body.scopes.includes("payment_requests:write"), false);
  const stored = keys[0];
  assert.ok(stored);
  assert.equal(JSON.stringify(stored).includes(body.secret!), false);
  assert.equal(stored.hash, hashApiSecret(body.secret!, PEPPER));
  const listed = await handleListApiKeys(
    await walletRequest(A, WALLET_ACTIONS.apiKeysList, "https://pay.example/api/v1/api-keys"),
    runtime,
  );
  assert.equal(listed.status, 200);
  const keysBody = (listed.body as { keys: Record<string, unknown>[] }).keys;
  assert.equal("secret" in keysBody[0], false);
  assert.equal("hash" in keysBody[0], false);
  assert.equal(keysBody[0].secretSet, true);
  const got = await handleGetApiKey(
    await walletRequest(A, WALLET_ACTIONS.apiKeysGet, "https://pay.example/api/v1/api-keys/" + body.id),
    body.id,
    runtime,
  );
  assert.equal(got.status, 200);
  assert.equal("secret" in got.body, false);
  assert.equal(JSON.stringify(got.body).includes(body.secret!), false);
});

test("plaintext API secrets are not written into the store blob", async () => {
  await withFile(async (path) => {
    const live = liveApiKeyRuntime();
    const runtime: ApiKeyRuntime = withMemoryNonces({ ...live, pepper: PEPPER, nowSeconds: () => NOW });
    const request = await walletRequest(A, WALLET_ACTIONS.apiKeysCreate, "https://pay.example/api/v1/api-keys", {
      name: "blob",
      scopes: ["webhooks:read", "webhooks:write"],
    });
    const created = await handleCreateApiKey(request, runtime);
    assert.equal(created.status, 200);
    const secret = (created.body as { secret: string }).secret;
    const blob = await readFile(path, "utf8");
    assert.equal(blob.includes(secret), false);
    assert.equal(blob.includes(PEPPER), false);
    assert.match(blob, /"hash":"[0-9a-f]{64}"/);
    const parsed = JSON.parse(blob) as { records: Record<string, unknown>; apiKeys: { keys: Record<string, { hash: string }> } };
    const stored = Object.values(parsed.apiKeys.keys)[0];
    assert.equal(stored.hash, hashApiSecret(secret, PEPPER));
  });
});

test("rotation invalidates the old secret and the new secret works once", async () => {
  resetApiKeyRateLimits();
  resetApiKeyUseThrottle();
  const { runtime } = memoryRuntime();
  const created = await handleCreateApiKey(
    await walletRequest(A, WALLET_ACTIONS.apiKeysCreate, "https://pay.example/api/v1/api-keys", {
      name: "rotate",
      scopes: ["verification:read"],
    }),
    runtime,
  );
  const first = created.body as { id: string; secret: string };
  const rotated = await handleRotateApiKey(
    await walletRequest(A, WALLET_ACTIONS.apiKeysRotate, "https://pay.example/api/v1/api-keys/" + first.id + "/rotate", {}),
    first.id,
    runtime,
  );
  assert.equal(rotated.status, 200);
  const next = rotated.body as { secret: string };
  assert.notEqual(next.secret, first.secret);
  const oldAuth = await authenticateAuthorization(bearer(first.secret), "verification:read", runtime);
  assert.equal(oldAuth.ok, false);
  const newAuth = await authenticateAuthorization(bearer(next.secret), "verification:read", runtime);
  assert.equal(newAuth.ok, true);
  const again = await handleGetApiKey(
    await walletRequest(A, WALLET_ACTIONS.apiKeysGet, "https://pay.example/api/v1/api-keys/" + first.id),
    first.id,
    runtime,
  );
  assert.equal("secret" in again.body, false);
});

test("a revoked key stops working", async () => {
  const { secret, row } = issue(A.address, ["receipts:read"]);
  const { runtime } = memoryRuntime([row]);
  const deleted = await handleDeleteApiKey(
    await walletRequest(A, WALLET_ACTIONS.apiKeysDelete, "https://pay.example/api/v1/api-keys/" + row.id),
    row.id,
    runtime,
  );
  assert.equal(deleted.status, 200);
  const auth = await authenticateAuthorization(bearer(secret), "receipts:read", runtime);
  assert.equal(auth.ok, false);
  if (auth.ok) return;
  assert.equal(auth.message, AUTH_MESSAGE);
});

test("body merchant cannot override the API key merchant", async () => {
  const { secret, row } = issue(A.address, ["payment_requests:write"]);
  const rows: PayRecord[] = [];
  const { runtime } = memoryRuntime([row]);
  const fields = validateFinalRequest({
    version: 2,
    requestId: REQUEST_ID,
    merchant: B.address,
    recipient: B.address,
    amountBaseUnits: 1_000_000n,
    memo: "NOT-A",
    chainId: 5042,
    expiresAt: NOW + 10_000,
    nonce: NONCE,
  });
  const signed = await signFinalRequest(fields, B);
  const result = await createPaymentRequest(
    new Request("https://pay.example/api/v1/payment-requests?api_key=" + secret, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: bearer(secret) },
      body: JSON.stringify({
        requestId: signed.requestId,
        merchant: B.address,
        recipient: B.address,
        amountBaseUnits: "1000000",
        memo: signed.memo,
        chainId: 5042,
        expiresAt: signed.expiresAt,
        nonce: signed.nonce,
        signature: signed.signature,
        status: "PAID",
        apiKey: secret,
      }),
    }),
    payDeps(runtime, bearer(secret), rows),
  );
  assert.equal(result.status, 403);
  assert.equal(errorOf(result.body).code, API_ERROR_CODES.forbidden);
  assert.equal(rows.length, 0);
  assert.equal(JSON.stringify(result.body).includes(secret), false);
});

test("request id lookup is the earliest row owned by this merchant", async () => {
  const { secret, row } = issue(A.address, ["payment_requests:read"]);
  const { runtime } = memoryRuntime([row]);
  const requestA = await signFinalRequest(
    validateFinalRequest({
      version: 2,
      requestId: REQUEST_ID,
      merchant: A.address,
      recipient: A.address,
      amountBaseUnits: 2_000_000n,
      memo: "A-LATE",
      chainId: 5042,
      expiresAt: NOW + 10_000,
      nonce: NONCE,
    }),
    A,
  );
  const requestB = await signFinalRequest(
    validateFinalRequest({
      version: 2,
      requestId: REQUEST_ID,
      merchant: B.address,
      recipient: B.address,
      amountBaseUnits: 1_000_000n,
      memo: "B-EARLY",
      chainId: 5042,
      expiresAt: NOW + 10_000,
      nonce: ("0x" + "33".repeat(32)) as Hex,
    }),
    B,
  );
  const rows: PayRecord[] = [
    {
      token: encodeV2PayRequest(requestB),
      id: REQUEST_ID,
      to: B.address,
      amount: "1",
      memo: "B-EARLY",
      createdAt: "2020-01-01T00:00:00.000Z",
      views: 0,
      lastViewedAt: null,
      cancelled: false,
      cancelledAt: null,
      paidTx: null,
      webhookUrl: null,
    },
    {
      token: encodeV2PayRequest(requestA),
      id: REQUEST_ID,
      to: A.address,
      amount: "2",
      memo: "A-LATE",
      createdAt: "2020-06-01T00:00:00.000Z",
      views: 0,
      lastViewedAt: null,
      cancelled: false,
      cancelledAt: null,
      paidTx: null,
      webhookUrl: null,
    },
  ];
  const found = await getPaymentRequest(REQUEST_ID, payDeps(runtime, bearer(secret), rows));
  assert.equal(found.status, 200);
  const body = found.body as { merchant: string; memo: string };
  assert.equal(body.merchant, A.address);
  assert.equal(body.memo, "A-LATE");
});

test("lastUsedAt updates on success only, at most once a minute", async () => {
  resetApiKeyUseThrottle();
  const { secret, row } = issue(A.address, ["verification:read"]);
  const box = memoryRuntime([row]);
  const first = await authenticateAuthorization(bearer(secret), "verification:read", box.runtime);
  assert.equal(first.ok, true);
  assert.equal(box.touches(), 1);
  assert.equal(box.keys[0].lastUsedAt, new Date(NOW * 1000).toISOString());
  const second = await authenticateAuthorization(bearer(secret), "verification:read", box.runtime);
  assert.equal(second.ok, true);
  assert.equal(box.touches(), 1);
  const bad = await authenticateAuthorization(bearer(generateApiSecret()), "verification:read", box.runtime);
  assert.equal(bad.ok, false);
  assert.equal(box.touches(), 1);
  box.clock.value = NOW + 61;
  const third = await authenticateAuthorization(bearer(secret), "verification:read", box.runtime);
  assert.equal(third.ok, true);
  assert.equal(box.touches(), 2);
});

test("authentication errors do not leak secrets, hashes, or the pepper", async () => {
  const { secret, row } = issue(A.address, ["payment_requests:read"]);
  const { runtime } = memoryRuntime([row]);
  runtime.pepper = null;
  const missingPepper = await authenticateAuthorization(bearer(secret), "payment_requests:read", runtime);
  assert.equal(missingPepper.ok, false);
  if (missingPepper.ok) return;
  assert.equal(missingPepper.status, 503);
  const packed = JSON.stringify(missingPepper);
  assert.equal(packed.includes(secret), false);
  assert.equal(packed.includes(row.hash), false);
  assert.equal(packed.includes(PEPPER), false);
  assert.equal(packed.includes("FINAL_API_KEY_PEPPER"), false);
});

test("verify stays global and does not merchant-filter the transaction", async () => {
  const { secret, row } = issue(A.address, ["verification:read"]);
  const { runtime } = memoryRuntime([row]);
  const loaded: LoadedReceipt = {
    parsed: {
      txHash: TX,
      status: "success",
      isMemo: true,
      transactionSucceeded: true,
      memoEventValid: true,
      settlementValid: true,
      blockNumber: "10",
      blockHash: ("0x" + "cd".repeat(32)) as Hash,
      from: B.address,
      to: B.address,
      amount: "9",
      memo: "someone-else",
      memoId: ("0x" + "ee".repeat(32)) as Hex,
      memoIndex: "1",
      sender: B.address,
      feeUsdc: "0",
      gasUsed: "1",
    },
    certificate: null,
    certCheck: {
      matched: false,
      signatureCount: 0,
      signaturesCryptographicallyVerified: false,
      note: "not checked",
    },
  };
  const deps = payDeps(runtime, bearer(secret), []);
  deps.loadReceipt = async () => loaded;
  const result = await verifyTransaction(TX, deps);
  assert.equal(result.status, 200);
  const body = result.body as { usdcTransfer: { recipient: string }; memo: string; note: string };
  assert.equal(body.usdcTransfer.recipient, B.address);
  assert.equal(body.memo, "someone-else");
  assert.match(body.note, /do not prove it settles a payment request/i);
});

test("dashboard wallet auth lists only the signing merchant and rejects a bare address", async () => {
  const own = issue(A.address, DEFAULT_API_KEY_SCOPES, "mine");
  const other = issue(B.address, DEFAULT_API_KEY_SCOPES, "theirs");
  const { runtime } = memoryRuntime([own.row, other.row]);
  const bare = new Request("https://pay.example/api/v1/api-keys", {
    headers: { [WALLET_AUTH_HEADERS.merchant]: A.address },
  });
  const denied = await handleListApiKeys(bare, runtime);
  assert.equal(denied.status, 401);
  assert.equal(errorOf(denied.body).message, AUTH_MESSAGE);
  const listed = await handleListApiKeys(
    await walletRequest(A, WALLET_ACTIONS.apiKeysList, "https://pay.example/api/v1/api-keys"),
    runtime,
  );
  assert.equal(listed.status, 200);
  const keys = (listed.body as { keys: { name: string; merchant: string }[] }).keys;
  assert.equal(keys.length, 1);
  assert.equal(keys[0].name, "mine");
  assert.equal(keys[0].merchant, A.address);
  const wrongSigner = await walletRequest(B, WALLET_ACTIONS.apiKeysList, "https://pay.example/api/v1/api-keys");
  wrongSigner.headers.set(WALLET_AUTH_HEADERS.merchant, A.address);
  const crossed = await handleListApiKeys(wrongSigner, runtime);
  assert.equal(crossed.status, 401);
});

test("authentication does not modify a payment row", async () => {
  await withFile(async () => {
    const record: PayRecord = {
      token: "tok-auth",
      id: "legacy",
      to: A.address,
      amount: "1.00",
      memo: "keep",
      createdAt: "2026-01-01T00:00:00.000Z",
      views: 0,
      lastViewedAt: null,
      cancelled: false,
      cancelledAt: null,
      paidTx: null,
      webhookUrl: null,
    };
    await upsertRecord(record);
    const before = await getRecord("tok-auth");
    const { secret, row } = issue(A.address, ["payment_requests:read"]);
    const live = liveApiKeyRuntime();
    const runtime: ApiKeyRuntime = {
      ...live,
      pepper: PEPPER,
      nowSeconds: () => NOW,
      listKeys: async () => [row],
    };
    const auth = await authenticateAuthorization(bearer(secret), "payment_requests:read", runtime);
    assert.equal(auth.ok, true);
    const after = await getRecord("tok-auth");
    assert.deepEqual(after, before);
    assert.equal(after?.paidTx, null);
    assert.equal(after?.cancelled, false);
  });
});

test("a query-string key is not accepted", async () => {
  const { secret, row } = issue(A.address, ["payment_requests:read"]);
  const { runtime } = memoryRuntime([row]);
  const result = await authenticateAuthorization(null, "payment_requests:read", runtime);
  assert.equal(result.ok, false);
  const rows: PayRecord[] = [];
  const looked = await getPaymentRequest(
    REQUEST_ID,
    payDeps(runtime, null, rows),
  );
  assert.equal(looked.status, 401);
  assert.equal(errorOf(looked.body).message, AUTH_MESSAGE);
  assert.equal(secret.length > 0, true);
});

test("rate limit is per API key and uses the error envelope", async () => {
  resetApiKeyRateLimits();
  const { secret, row } = issue(A.address, ["webhooks:read"]);
  const { runtime } = memoryRuntime([row]);
  runtime.rateLimitPerMinute = 2;
  assert.equal((await authenticateAuthorization(bearer(secret), "webhooks:read", runtime)).ok, true);
  assert.equal((await authenticateAuthorization(bearer(secret), "webhooks:read", runtime)).ok, true);
  const limited = await authenticateAuthorization(bearer(secret), "webhooks:read", runtime);
  assert.equal(limited.ok, false);
  if (limited.ok) return;
  assert.equal(limited.status, 429);
  assert.equal(limited.code, "rate_limited");
});

test("an API key cannot create or revoke other API keys", async () => {
  const { secret, row } = issue(A.address, API_SCOPES);
  const { runtime } = memoryRuntime([row]);
  const request = new Request("https://pay.example/api/v1/api-keys", {
    method: "POST",
    headers: { authorization: bearer(secret), "content-type": "application/json" },
    body: JSON.stringify({ name: "child", merchant: A.address }),
  });
  const created = await handleCreateApiKey(request, runtime);
  assert.equal(created.status, 401);
  assert.equal(errorOf(created.body).message, AUTH_MESSAGE);
});

test("a bearer token cannot switch merchants by naming another address", async () => {
  const { secret, row } = issue(A.address, ["webhooks:write"]);
  const { runtime } = memoryRuntime([row]);
  const auth = await authenticateAuthorization(bearer(secret), "webhooks:write", runtime);
  assert.equal(auth.ok, true);
  if (!auth.ok) return;
  assert.notEqual(auth.merchant, B.address);
});

test("reconciliation modules and new auth code do not call the matcher", async () => {
  const locked = [
    "src/lib/reconcilePayment.ts",
    "src/lib/payPaid.ts",
    "src/lib/receipt.ts",
    "src/lib/payRequest.ts",
    "src/lib/finalRequest.ts",
  ];
  for (const file of locked) {
    const text = await readFile(join(process.cwd(), file), "utf8");
    assert.equal(text.includes("final_live_"), false);
    assert.equal(text.includes("FINAL_API_KEY_PEPPER"), false);
    assert.equal(text.includes("authenticateAuthorization"), false);
  }
  const phase = await readFile(join(process.cwd(), "src/lib/payRequest.ts"), "utf8");
  assert.match(phase, /export function paymentLinkPhase/);
  const added = ["src/lib/apiKeys.ts", "src/lib/apiScopes.ts"];
  for (const file of added) {
    const text = await readFile(join(process.cwd(), file), "utf8");
    assert.equal(text.includes("reconcilePaymentRecord"), false);
    assert.equal(text.includes("findSettlementProof"), false);
    assert.equal(text.includes("findProofV2"), false);
    assert.equal(text.includes("verifyReceiptForRequest"), false);
    assert.equal(text.includes("markPaid"), false);
  }
  const store = await readFile(join(process.cwd(), "src/lib/payStore.ts"), "utf8");
  assert.match(store, /export async function markPaid/);
  assert.match(store, /store\.records\[record\.token\]/);
  assert.match(store, /preserveApiKeySection/);
});

test("public key view never includes the hash", () => {
  const { row, secret } = issue(A.address);
  const pub = toPublicApiKey(row);
  assert.equal("hash" in pub, false);
  assert.equal("secret" in pub, false);
  assert.equal(JSON.stringify(pub).includes(secret), false);
  assert.equal(JSON.stringify(pub).includes(row.hash), false);
});
