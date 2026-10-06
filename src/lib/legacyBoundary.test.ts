import { randomBytes as webhookTestKeyBytes } from "node:crypto";
/**
 * Phase 13 — Batch 0 + Batch 1 regression tests.
 * P1-01 API-key pepper fail-closed, P1-03 legacy record injection,
 * P1-04 legacy webhookUrl retirement, P1-05 legacy merchant data authorization.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  authenticateAuthorization,
  authorizeHttp,
  generateApiSecret,
  handleCreateApiKey,
  handleRotateApiKey,
  hashApiSecret,
  liveApiKeyRuntime,
  resetApiKeyRateLimits,
  type ApiKeyRecord,
  type ApiKeyRuntime,
} from "./apiKeys";
import { WALLET_ACTIONS, WALLET_AUTH_HEADERS, type ApiScope } from "./apiScopes";
import { signedWalletRequest, withMemoryNonces } from "./walletAuthTest";
import { ARC_CHAIN_ID } from "./arc";
import { observeCheckoutRecord } from "./checkoutObserve";
import { signFinalRequest, validateFinalRequest, type FinalRequest } from "./finalRequest";
import { createPolicy, type PolicyDeps } from "./paymentPolicies";
import { encodePayRequest, encodeV2PayRequest } from "./payRequest";
import { payGet, payPost, publicPayRecord, statementGet, type PayStatusDeps } from "./payStatusHttp";
import { mergePayRecord, type PayRecord, type StoreFile } from "./payStore";
import { FixedWindowLimiter, LEGACY_RATE_RULES, legacyRateLimiter, requestClientKey } from "./publicRateLimit";
import {
  LIMIT_EXCEEDED_CODE,
  MAX_ACTIVE_API_KEYS_PER_MERCHANT,
  MAX_PAYMENT_RECORDS_PER_MERCHANT,
  MAX_POLICIES_PER_MERCHANT,
  MAX_STORED_API_KEYS_PER_MERCHANT,
  MAX_WEBHOOK_ENDPOINTS_PER_MERCHANT,
  ResourceLimitExceededError,
  countPayRecordsOwnedBy,
  ownsPayRecord,
  payRecordOwner,
} from "./resourceLimits";
import { cachedWalletHeaders } from "./walletAuthCache";
import {
  createWebhookEndpoint,
  defaultWebhookDeps,
  signWebhookBody,
  validateWebhookUrl,
  verifyWebhookSignature,
} from "./webhooks";

// P3-06: webhook secrets are encrypted at rest; tests use a random per-run key (never a real key).
process.env.FINAL_WEBHOOK_ENCRYPTION_KEY = webhookTestKeyBytes(32).toString("hex");

const KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const KEY_B = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const A = privateKeyToAccount(KEY_A);
const B = privateKeyToAccount(KEY_B);
const PEPPER = "phase13-test-pepper-placeholder";
const NOW = Math.floor(Date.now() / 1000);
const METADATA_URL = "https://169.254.169.254/latest/meta-data/";
const STORED_HOOK = "https://merchant-a.example/legacy-hook";

const root = join(import.meta.dirname, "..", "..");
const src = (rel: string) => readFileSync(join(root, rel), "utf8");

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function v1Token(to: Address, memo = "legacy-1"): string {
  return encodePayRequest({ to, amount: "1.5", memo });
}

async function v2Token(
  signerKey: Hex,
  opts: { merchant: Address; memo?: string; amount?: bigint; requestByte?: string } = {
    merchant: A.address,
  },
): Promise<{ token: string; request: FinalRequest }> {
  const fields = validateFinalRequest({
    version: 2,
    requestId: ("0x" + (opts.requestByte ?? "11").repeat(16)) as Hex,
    merchant: opts.merchant,
    recipient: opts.merchant,
    amountBaseUnits: opts.amount ?? 2_000_000n,
    memo: opts.memo ?? "INV-13",
    chainId: ARC_CHAIN_ID,
    expiresAt: NOW + 86_400,
    nonce: ("0x" + "a1".repeat(32)) as Hex,
  });
  const account = privateKeyToAccount(signerKey);
  // signFinalRequest refuses a signer that is not the merchant; sign directly for forged cases.
  const request: FinalRequest =
    account.address === fields.merchant
      ? await signFinalRequest(fields, signerKey)
      : { ...fields, signature: await account.signTypedData((await import("./finalRequest")).finalRequestTypedData(fields)) };
  return { token: encodeV2PayRequest(request), request };
}

/**
 * A V2-claiming token whose recipient differs from its merchant. Canonical
 * validation (validateFinalRequest) forbids this, so it never decodes.
 */
function craftedMismatchV2(merchant: Address, recipient: Address, byte = "77"): string {
  const json = JSON.stringify({
    v: 2,
    requestId: "0x" + byte.repeat(16),
    merchant,
    recipient,
    amountBaseUnits: "1000000",
    memo: "planted",
    chainId: ARC_CHAIN_ID,
    expiresAt: NOW + 3600,
    nonce: "0x" + "b2".repeat(32),
    signature: "0x" + "11".repeat(65),
  });
  return Buffer.from(json, "utf8").toString("base64url");
}

function row(token: string, to: Address, overrides: Partial<PayRecord> = {}): PayRecord {
  return {
    token,
    id: "legacy",
    to,
    amount: "1.5",
    memo: "legacy-1",
    createdAt: "2026-10-01T00:00:00.000Z",
    views: 0,
    lastViewedAt: null,
    cancelled: false,
    cancelledAt: null,
    paidTx: null,
    webhookUrl: null,
    ...overrides,
  };
}

function issueKey(merchant: Address, scopes: ApiScope[], extra: Partial<ApiKeyRecord> = {}) {
  const secret = generateApiSecret();
  const record: ApiKeyRecord = {
    id: `key_${createHash("sha256").update(secret).digest("hex").slice(0, 16)}`,
    merchant,
    name: "test",
    prefix: secret.slice(0, 19),
    hash: hashApiSecret(secret, PEPPER),
    scopes,
    enabled: true,
    revoked: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
    ...extra,
  };
  return { secret, record };
}

function keyRuntime(keys: ApiKeyRecord[] = [], pepper: string | null = PEPPER) {
  const rows = keys.map((k) => ({ ...k, scopes: [...k.scopes] }));
  let upserts = 0;
  const runtime: ApiKeyRuntime = {
    nowSeconds: () => NOW,
    pepper,
    listKeys: async () => rows.map((k) => ({ ...k, scopes: [...k.scopes] })),
    upsertKey: async (next) => {
      upserts += 1;
      const i = rows.findIndex((k) => k.id === next.id);
      if (i >= 0) rows[i] = next;
      else rows.push(next);
    },
    createKey: async (next) => {
      const merchant = getAddress(next.merchant);
      const mine = rows.filter((k) => getAddress(k.merchant) === merchant);
      if (mine.filter((k) => !k.revoked).length >= MAX_ACTIVE_API_KEYS_PER_MERCHANT) {
        throw new ResourceLimitExceededError("Active API key limit reached. Revoke an unused key first.");
      }
      if (mine.length >= MAX_STORED_API_KEYS_PER_MERCHANT) {
        throw new ResourceLimitExceededError("API key limit reached for this merchant.");
      }
      upserts += 1;
      rows.push(next);
    },
    touchLastUsed: async () => {},
  };
  return { runtime: withMemoryNonces(runtime), rows, upserts: () => upserts };
}

async function walletHeaders(
  account: typeof A,
  action: string,
  timestamp = NOW,
  url = "http://localhost/api/pay",
  method = "GET",
  body?: unknown,
): Promise<Record<string, string>> {
  const req = await signedWalletRequest({ account, action, url, method, body, timestamp });
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

async function signedPostPay(account: typeof A, body: Record<string, unknown>, timestamp = NOW) {
  const headers = await walletHeaders(
    account,
    WALLET_ACTIONS.paymentsRegister,
    timestamp,
    "http://localhost/api/pay",
    "POST",
    body,
  );
  return post(body, headers);
}

async function signedCreateKey(account: typeof A, body: Record<string, unknown>) {
  const headers = await walletHeaders(
    account,
    WALLET_ACTIONS.apiKeysCreate,
    NOW,
    "http://localhost/api/v1/api-keys",
    "POST",
    body,
  );
  return new Request("http://localhost/api/v1/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function memoryDeps(seed: PayRecord[] = [], opts: { keys?: ApiKeyRecord[]; limiter?: PayStatusDeps["rateLimit"] } = {}) {
  const records = new Map(seed.map((r) => [r.token, structuredClone(r)]));
  const calls = { find: 0, list: 0, ledger: 0, write: 0, authorize: 0, count: 0, viewed: 0 };
  const emitted: { type: "created" | "cancelled"; row: PayRecord }[] = [];
  const keys = keyRuntime(opts.keys ?? []);
  const deps: PayStatusDeps = {
    async getRecord(token) {
      return records.get(token) ? structuredClone(records.get(token)!) : null;
    },
    async listByPayee(to) {
      calls.list += 1;
      return [...records.values()].filter((r) => r.to.toLowerCase() === to.toLowerCase()).map((r) => structuredClone(r));
    },
    async markCancelled() {
      calls.write += 1;
      return null;
    },
    async markPaid() {
      calls.write += 1;
      return null;
    },
    async markViewed(token) {
      calls.viewed += 1;
      calls.write += 1;
      const current = records.get(token);
      if (!current) return null;
      current.views += 1;
      return structuredClone(current);
    },
    async upsertRecord(record) {
      calls.write += 1;
      const next = mergePayRecord(records.get(record.token), record);
      records.set(record.token, next);
      return structuredClone(next);
    },
    async createOwnedRecord(record, owner) {
      calls.write += 1;
      calls.count += 1;
      const existing = records.get(record.token);
      if (existing) {
        const next = mergePayRecord(existing, record);
        records.set(record.token, next);
        return { record: structuredClone(next), created: false };
      }
      if (countPayRecordsOwnedBy(records.values(), owner) >= MAX_PAYMENT_RECORDS_PER_MERCHANT) {
        throw new ResourceLimitExceededError("Payment request limit reached for this merchant.");
      }
      records.set(record.token, record);
      return { record: structuredClone(record), created: true };
    },
    async findSettlementProof() {
      calls.find += 1;
      return null;
    },
    async loadMemoLedger() {
      calls.ledger += 1;
      return [];
    },
    authorize: async (request, o) => {
      calls.authorize += 1;
      return authorizeHttp(request, o, keys.runtime);
    },
    rateLimit: opts.limiter ?? (() => true),
    clientKey: () => "ip:test",
    emitCreated: (r) => emitted.push({ type: "created", row: r }),
    emitCancelled: (r) => emitted.push({ type: "cancelled", row: r }),
  };
  const snapshot = () => JSON.stringify([...records.entries()].sort());
  return { deps, records, calls, emitted, snapshot };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/pay", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function get(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { headers });
}

function errorCode(body: unknown): string | undefined {
  return (body as { code?: string }).code;
}

function noFetch() {
  return mock.method(globalThis, "fetch", async () => {
    throw new Error("legacy boundary must not make outbound requests");
  });
}

// ---------------------------------------------------------------------------
// P1-01 — API-key pepper fail-closed
// ---------------------------------------------------------------------------

test("P1-01: missing or blank FINAL_API_KEY_PEPPER yields a null pepper (no generated fallback)", () => {
  const saved = process.env.FINAL_API_KEY_PEPPER;
  try {
    delete process.env.FINAL_API_KEY_PEPPER;
    assert.equal(liveApiKeyRuntime().pepper, null);
    process.env.FINAL_API_KEY_PEPPER = "   ";
    assert.equal(liveApiKeyRuntime().pepper, null);
    process.env.FINAL_API_KEY_PEPPER = PEPPER;
    assert.equal(liveApiKeyRuntime().pepper, PEPPER);
  } finally {
    if (saved === undefined) delete process.env.FINAL_API_KEY_PEPPER;
    else process.env.FINAL_API_KEY_PEPPER = saved;
  }
});

test("P1-01: missing pepper fails closed for auth, create, and rotate, and stores nothing", async () => {
  const { secret, record } = issueKey(A.address, ["payment_requests:read"]);
  const box = keyRuntime([record], null);
  const auth = await authenticateAuthorization(`Bearer ${secret}`, "payment_requests:read", box.runtime);
  assert.equal(auth.ok, false);
  if (!auth.ok) {
    assert.equal(auth.status, 503);
    assert.equal(auth.code, "unavailable");
  }
  const create = await handleCreateApiKey(await signedCreateKey(A, { name: "desk" }), box.runtime);
  assert.equal(create.status, 503);
  const rotate = await handleRotateApiKey(
    new Request(`http://localhost/api/v1/api-keys/${record.id}/rotate`, {
      method: "POST",
      headers: await walletHeaders(
        A,
        WALLET_ACTIONS.apiKeysRotate,
        NOW,
        `http://localhost/api/v1/api-keys/${record.id}/rotate`,
        "POST",
        "",
      ),
    }),
    record.id,
    box.runtime,
  );
  assert.equal(rotate.status, 503);
  assert.equal(box.upserts(), 0);
  // Missing pepper is checked before any store read or route-level work.
  const viaHttp = await authorizeHttp(
    get("http://localhost/x", { authorization: `Bearer ${secret}` }),
    { scope: "payment_requests:read" },
    box.runtime,
  );
  assert.equal(viaHttp.ok === true, false);
  if ("body" in viaHttp) assert.equal(viaHttp.status, 503);
});

test("P1-01: no unsalted fallback — the stored hash is HMAC(pepper) and a different pepper never matches", async () => {
  const { secret, record } = issueKey(A.address, ["payment_requests:read"]);
  assert.notEqual(record.hash, createHash("sha256").update(secret).digest("hex"));
  assert.notEqual(hashApiSecret(secret, PEPPER), hashApiSecret(secret, `${PEPPER}-rotated`));
  const wrongPepper = keyRuntime([record], `${PEPPER}-rotated`);
  const auth = await authenticateAuthorization(`Bearer ${secret}`, "payment_requests:read", wrongPepper.runtime);
  assert.equal(auth.ok, false);
  if (!auth.ok) assert.equal(auth.status, 401);
  const source = src("src/lib/apiKeys.ts");
  assert.doesNotMatch(source, /createHash\(/);
  assert.doesNotMatch(source, /\?\?\s*["'`][^"'`]+["'`]\s*;?\s*\/\/.*pepper/i);
  assert.match(source, /if \(!pepper\)/);
});

test("P1-01: missing-pepper errors leak no secret, hash, pepper, or env name; docs use placeholders only", async () => {
  const { secret, record } = issueKey(A.address, ["payment_requests:read"]);
  const box = keyRuntime([record], null);
  const result = await authorizeHttp(
    get("http://localhost/x", { authorization: `Bearer ${secret}` }),
    { scope: "payment_requests:read" },
    box.runtime,
  );
  const text = JSON.stringify(result);
  for (const needle of [secret, record.hash, PEPPER, "FINAL_API_KEY_PEPPER", "process.env"]) {
    assert.equal(text.includes(needle), false, needle);
  }
  const readme = src("README.md");
  assert.match(readme, /FINAL_API_KEY_PEPPER/);
  assert.match(readme, /invalidates every existing API key/i);
  assert.match(readme, /FINAL_API_KEY_PEPPER=<[^>\n]+>/);
  // No real-looking secret (long hex/base64 run) assigned to the pepper in docs.
  assert.doesNotMatch(readme, /FINAL_API_KEY_PEPPER\s*=\s*[A-Za-z0-9+/_-]{24,}/);
});

// ---------------------------------------------------------------------------
// P1-03 — legacy record injection
// ---------------------------------------------------------------------------

test("P1-03 #4: unauthenticated caller cannot create a V1 merchant record", async () => {
  const token = v1Token(A.address);
  const box = memoryDeps();
  const before = box.snapshot();
  const result = await payPost(post({ token, action: "register" }), box.deps);
  assert.equal(result.status, 401);
  assert.equal(box.snapshot(), before);
  assert.equal(box.calls.write, 0);
  assert.equal(box.emitted.length, 0);
  // Default action is register too.
  const implicit = await payPost(post({ token }), box.deps);
  assert.equal(implicit.status, 401);
  assert.equal(box.records.size, 0);
});

test("P1-03 #5: forged V2 registration is rejected by the canonical EIP-712 check", async () => {
  const box = memoryDeps();
  // Signed by B but claims merchant A.
  const forged = await v2Token(KEY_B, { merchant: A.address });
  const r1 = await payPost(post({ token: forged.token, action: "register" }), box.deps);
  assert.equal(r1.status, 400);
  assert.equal(errorCode(r1.body), "invalid_signature");
  // Genuine A signature, amount tampered after signing.
  const genuine = await v2Token(KEY_A, { merchant: A.address, requestByte: "22" });
  const tampered = encodeV2PayRequest({ ...genuine.request, amountBaseUnits: 1n });
  const r2 = await payPost(post({ token: tampered, action: "register" }), box.deps);
  assert.equal(r2.status, 400);
  assert.equal(box.records.size, 0);
  assert.equal(box.calls.write, 0);
  assert.equal(box.emitted.length, 0);
});

test("P1-03 #6: valid V2 registration still works, is idempotent, and emits created once", async () => {
  const box = memoryDeps();
  const { token } = await v2Token(KEY_A, { merchant: A.address });
  const first = await payPost(post({ token, action: "register" }), box.deps);
  assert.equal(first.status, 200);
  assert.equal(box.records.size, 1);
  assert.equal(box.emitted.length, 1);
  assert.equal(getAddress(box.emitted[0]!.row.to), A.address);
  const writes = box.calls.write;
  const second = await payPost(post({ token, action: "register" }), box.deps);
  assert.equal(second.status, 200);
  assert.equal(box.calls.write, writes);
  assert.equal(box.emitted.length, 1);
  assert.equal(box.calls.find, 0, "registration does not reconcile");
});

test("P1-03 #6b: V1 registration works with the payee's wallet authorization or a payment_requests:write key", async () => {
  const box = memoryDeps([], { keys: [issueKey(A.address, ["payment_requests:write"]).record] });
  const token = v1Token(A.address);
  const ok = await payPost(await signedPostPay(A, { token, action: "register" }), box.deps);
  assert.equal(ok.status, 200);
  assert.equal(box.records.size, 1);
  assert.equal(box.emitted.length, 1);

  const key = issueKey(A.address, ["payment_requests:write"]);
  const box2 = memoryDeps([], { keys: [key.record] });
  const viaKey = await payPost(post({ token: v1Token(A.address, "k") }, { authorization: `Bearer ${key.secret}` }), box2.deps);
  assert.equal(viaKey.status, 200);
  resetApiKeyRateLimits();
});

test("P1-03 #7/#8: V1 and V2 public observation still work and never create a record", async () => {
  const v1 = v1Token(A.address);
  const v2 = (await v2Token(KEY_A, { merchant: A.address })).token;
  const box = memoryDeps();
  for (const token of [v1, v2]) {
    const observed = await observeCheckoutRecord(token, { getRecord: box.deps.getRecord });
    assert.equal(observed.status, 200);
  }
  const unknown = await payGet(get(`http://localhost/api/pay?token=${encodeURIComponent(v1)}`), box.deps);
  assert.equal(unknown.status, 404);
  const view = await payPost(post({ token: v2, action: "view" }), box.deps);
  assert.equal(view.status, 404);
  assert.equal(box.records.size, 0);
  assert.equal(box.calls.write, 0);
  assert.equal(box.calls.find, 0);

  // Phase 14: Existing V1 row token read is pure (zero reconciliation RPC).
  const seeded = memoryDeps([row(v1, A.address)]);
  const read = await payGet(get(`http://localhost/api/pay?token=${encodeURIComponent(v1)}`), seeded.deps);
  assert.equal(read.status, 200);
  assert.equal(seeded.calls.find, 0);
  // Checkout observe route source is still read-only.
  const observeImports = src("src/app/api/pay/observe/route.ts")
    .split("\n")
    .filter((line) => line.startsWith("import"))
    .join("\n");
  assert.doesNotMatch(observeImports, /payStatusHttp|upsertRecord|markViewed|reconcile|webhooks/);
  assert.match(observeImports, /observeCheckoutRecord/);
});

test("P1-03 #9: cross-merchant registration fails and wrong wallet action is rejected", async () => {
  const token = v1Token(A.address);
  const box = memoryDeps();
  const crossed = await payPost(await signedPostPay(B, { token, action: "register" }), box.deps);
  assert.equal(crossed.status, 403);
  const wrongAction = await payPost(await signedPostPay(A, { token, action: "register" }).then(async () => {
    const body = { token, action: "register" as const };
    const headers = await walletHeaders(A, WALLET_ACTIONS.paymentsRead, NOW, "http://localhost/api/pay", "POST", body);
    return post(body, headers);
  }), box.deps);
  assert.equal(wrongAction.status, 401);
  const stale = await payPost(await signedPostPay(A, { token, action: "register" }, NOW - 3600), box.deps);
  assert.equal(stale.status, 401);
  // A body "merchant"/"address" field cannot stand in for authentication.
  const bodyClaim = await payPost(post({ token, merchant: A.address, address: A.address }), box.deps);
  assert.equal(bodyClaim.status, 401);
  assert.equal(box.records.size, 0);
});

test("P1-03 #10: per-merchant record cap returns 409 and public writes are rate limited before any work", async () => {
  const { token } = await v2Token(KEY_A, { merchant: A.address });
  const box = memoryDeps();
  box.deps.createOwnedRecord = async () => {
    throw new ResourceLimitExceededError("Payment request limit reached for this merchant.");
  };
  const capped = await payPost(post({ token }), box.deps);
  assert.equal(capped.status, 409);
  assert.equal(errorCode(capped.body), LIMIT_EXCEEDED_CODE);
  assert.equal(box.records.size, 0);
  assert.equal(box.emitted.length, 0);

  const limited = memoryDeps([], { limiter: () => false });
  const r = await payPost(post({ token }), limited.deps);
  assert.equal(r.status, 429);
  assert.equal(errorCode(r.body), "rate_limited");
  assert.equal(limited.calls.write + limited.calls.count + limited.calls.authorize, 0);
});

test("P1-03: record ownership — V2 signer, V1 payee, malformed or mismatched rows own nothing", async () => {
  const mine = (await v2Token(KEY_A, { merchant: A.address, requestByte: "31" })).token;
  const v1 = v1Token(A.address);
  const mismatch = craftedMismatchV2(B.address, A.address, "32");
  assert.equal(payRecordOwner({ token: mine, to: A.address }), A.address);
  assert.equal(payRecordOwner({ token: v1, to: A.address }), A.address);
  // Canonical V2 requires recipient === merchant; a mismatched claim does not decode.
  assert.equal(payRecordOwner({ token: mismatch, to: A.address }), null);
  assert.equal(payRecordOwner({ token: "%%%", to: A.address }), null);
  // V1 ownership is the payee inside the token, not a stored "to" that disagrees with it.
  assert.equal(ownsPayRecord({ token: v1Token(B.address), to: A.address }, A.address), false);
  const rows = [
    { token: mine, to: A.address },
    { token: mismatch, to: A.address },
    { token: v1, to: A.address },
    { token: "garbage", to: A.address },
    { token: v1Token(B.address), to: B.address },
  ];
  assert.equal(countPayRecordsOwnedBy(rows, A.address), 2);
  assert.equal(countPayRecordsOwnedBy(rows, B.address), 1);
});

test("P1-03: API key, webhook endpoint, and policy creation caps return 409 limit_exceeded", async () => {
  // API keys
  const seeded = Array.from({ length: MAX_ACTIVE_API_KEYS_PER_MERCHANT }, (_, i) =>
    issueKey(A.address, ["payment_requests:read"], { id: `key_cap_${i}` }).record,
  );
  const keys = keyRuntime(seeded);
  const create = async () =>
    handleCreateApiKey(await signedCreateKey(A, { name: "one-more" }), keys.runtime);
  const blocked = await create();
  assert.equal(blocked.status, 409);
  assert.equal((blocked.body as { error: { code: string } }).error.code, LIMIT_EXCEEDED_CODE);
  assert.equal(keys.upserts(), 0);
  keys.rows[0]!.revoked = true;
  const afterRevoke = await create();
  assert.equal(afterRevoke.status, 200, "revoking frees an active slot");
  // B is unaffected by A's keys.
  const other = await handleCreateApiKey(await signedCreateKey(B, { name: "b" }), keys.runtime);
  assert.equal(other.status, 200);

  // Webhook endpoints (real store helpers on a temp JSON file).
  const dir = mkdtempSync(join(tmpdir(), "final-p13-"));
  const saved = { ...process.env };
  try {
    for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) {
      delete process.env[k];
    }
    process.env.FINAL_PAY_STORE = join(dir, "store.json");
    const endpoints: Record<string, unknown> = {};
    for (let i = 0; i < MAX_WEBHOOK_ENDPOINTS_PER_MERCHANT; i += 1) {
      endpoints[`wh_${i}`] = {
        id: `wh_${i}`,
        merchant: A.address,
        url: `https://hooks.example/${i}`,
        enabled: true,
        events: ["payment_request.created"],
        secret: `whsec_${"0".repeat(64)}`,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
    }
    const blob: StoreFile = { records: {}, webhooks: { endpoints, deliveries: {} } };
    writeFileSync(process.env.FINAL_PAY_STORE, JSON.stringify(blob));
    const deps = { ...defaultWebhookDeps(), caller: A.address };
    const capped = await createWebhookEndpoint({ merchant: A.address, url: "https://hooks.example/new", events: ["payment_request.created"] }, deps);
    assert.equal(capped.status, 409);
    assert.equal((capped.body as { error: { code: string } }).error.code, LIMIT_EXCEEDED_CODE);
    assert.equal(Object.keys(JSON.parse(readFileSync(process.env.FINAL_PAY_STORE, "utf8")).webhooks.endpoints).length, MAX_WEBHOOK_ENDPOINTS_PER_MERCHANT);
    const forB = await createWebhookEndpoint(
      { merchant: B.address, url: "https://hooks.example/b", events: ["payment_request.created"] },
      { ...defaultWebhookDeps(), caller: B.address },
    );
    assert.equal(forB.status, 200, "Phase 4 webhook creation still works under the cap");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }

  // Policies (memory blob).
  const key = issueKey(A.address, ["policies:write"]);
  let blob: StoreFile = { records: {} };
  const policyDeps: PolicyDeps = {
    nowSeconds: () => NOW,
    readBlob: async () => structuredClone(blob),
    mutateBlob: async (mutator) => {
      const next = structuredClone(blob);
      mutator(next);
      blob = next;
      return next;
    },
    emit: () => {},
    apiKeyAuth: { ...keyRuntime([key.record]).runtime, rateLimitPerMinute: 10_000 },
  };
  const make = (name: string) =>
    createPolicy(
      new Request("http://localhost/api/v1/policies", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key.secret}` },
        body: JSON.stringify({ name, rules: { maxAmountBaseUnits: "1000000" } }),
      }),
      policyDeps,
    );
  for (let i = 0; i < MAX_POLICIES_PER_MERCHANT; i += 1) assert.equal((await make(`p${i}`)).status, 200);
  const over = await make("over");
  assert.equal(over.status, 409);
  assert.equal((over.body as { error: { code: string } }).error.code, LIMIT_EXCEEDED_CODE);
  resetApiKeyRateLimits();
});

// ---------------------------------------------------------------------------
// P1-04 — legacy webhookUrl retired
// ---------------------------------------------------------------------------

test("P1-04 #11: registration cannot attach a webhookUrl", async () => {
  const box = memoryDeps();
  const { token } = await v2Token(KEY_A, { merchant: A.address });
  const result = await payPost(post({ token, action: "register", webhookUrl: "https://attacker.example/hook" }), box.deps);
  assert.equal(result.status, 200);
  assert.equal(box.records.get(token)?.webhookUrl, null);
  assert.equal(JSON.stringify(result.body).includes("attacker.example"), false);
});

test("P1-04 #12/#29: an existing stored webhookUrl cannot be overwritten or hijacked, and is never returned", async () => {
  const v1 = v1Token(A.address);
  const v2 = (await v2Token(KEY_A, { merchant: A.address })).token;
  const box = memoryDeps([row(v1, A.address, { webhookUrl: STORED_HOOK }), row(v2, A.address, { webhookUrl: STORED_HOOK })]);
  const before = box.snapshot();
  // Unauthenticated V1 overwrite attempt.
  assert.equal((await payPost(post({ token: v1, webhookUrl: "https://evil.example" }), box.deps)).status, 401);
  // Another merchant's wallet.
  assert.equal(
    (await payPost(await signedPostPay(B, { token: v1, webhookUrl: "https://evil.example", action: "register" }), box.deps)).status,
    403,
  );
  // Anyone holding the public V2 link (valid signature) re-registers with a new URL.
  const replay = await payPost(post({ token: v2, webhookUrl: "https://evil.example" }), box.deps);
  assert.equal(replay.status, 200);
  // Even the owner cannot set it: the field is retired.
  await payPost(await signedPostPay(A, { token: v1, webhookUrl: "https://evil.example", action: "register" }), box.deps);
  assert.equal(box.snapshot(), before);
  assert.equal(box.records.get(v1)?.webhookUrl, STORED_HOOK, "stored data is preserved, not deleted");
  for (const r of [replay]) assert.equal(JSON.stringify(r.body).includes(STORED_HOOK), false);
  const read = await payGet(get(`http://localhost/api/pay?token=${encodeURIComponent(v1)}`), box.deps);
  assert.equal(JSON.stringify(read.body).includes(STORED_HOOK), false);
  assert.equal(publicPayRecord(row(v1, A.address, { webhookUrl: STORED_HOOK })).webhookUrl, null);
});

test("P1-04 #13/#14/#15/#16/#28: no public legacy action makes any outbound request (no SSRF, no redirect, no unsigned body)", async () => {
  const fetchSpy = noFetch();
  try {
    const v1 = v1Token(A.address);
    const v2 = await v2Token(KEY_A, { merchant: A.address });
    const box = memoryDeps([row(v1, A.address, { webhookUrl: METADATA_URL }), row(v2.token, A.address, { webhookUrl: METADATA_URL })]);
    await payPost(post({ token: v1, action: "view" }), box.deps);
    await payPost(post({ token: v2.token, action: "view" }), box.deps);
    await payPost(post({ token: v2.token, action: "register", webhookUrl: METADATA_URL }), box.deps);
    await payGet(get(`http://localhost/api/pay?token=${encodeURIComponent(v1)}`), box.deps);
    await payPost(post({ token: v1, action: "cancel", address: A.address }), box.deps);
    assert.equal(fetchSpy.mock.callCount(), 0);
    assert.equal(box.calls.viewed, 2);
  } finally {
    fetchSpy.mock.restore();
  }
  // The legacy notifier is gone and nothing references it.
  assert.equal(existsSync(join(root, "src/lib/notify.ts")), false);
  const legacy = src("src/lib/payStatusHttp.ts");
  assert.doesNotMatch(legacy, /notifyWebhook|from "\.\/notify"|\bfetch\(/);
  assert.doesNotMatch(legacy, /body\.webhookUrl|webhookUrl:\s*body/);
});

test("P1-04 #14/#17: the Phase 4 webhook stack still blocks private targets, rejects redirects, and signs bodies", () => {
  for (const bad of [METADATA_URL, "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.1/x", "http://hooks.example/x", "https://user:pw@hooks.example/x"]) {
    assert.throws(() => validateWebhookUrl(bad), bad);
  }
  assert.equal(validateWebhookUrl("https://hooks.example/x"), "https://hooks.example/x");
  const secret = `whsec_${"ab".repeat(32)}`;
  const body = JSON.stringify({ type: "payment_request.created" });
  const signature = signWebhookBody(secret, NOW, body);
  assert.equal(verifyWebhookSignature({ secret, timestamp: String(NOW), rawBody: body, signature, nowSeconds: NOW }), true);
  const phase4 = src("src/lib/webhooks.ts");
  assert.match(phase4, /redirect: "error"/);
});

// ---------------------------------------------------------------------------
// P1-05 — legacy merchant data authorization
// ---------------------------------------------------------------------------

test("P1-05 #18/#19: unauthenticated ?to= and statement are 401 and do no store, chain, or ledger work", async () => {
  const box = memoryDeps([row(v1Token(A.address), A.address)]);
  const list = await payGet(get(`http://localhost/api/pay?to=${A.address}`), box.deps);
  assert.equal(list.status, 401);
  const statement = await statementGet(get(`http://localhost/api/statement?address=${A.address}`), box.deps);
  assert.equal(statement.status, 401);
  assert.equal(box.calls.list + box.calls.find + box.calls.ledger + box.calls.write, 0);
  // A key in the query string is never accepted.
  const smuggled = await payGet(get(`http://localhost/api/pay?to=${A.address}&api_key=final_live_x`), box.deps);
  assert.equal(smuggled.status, 401);
});

test("P1-05 #20: merchant A cannot list or read the statement of merchant B (404, no work)", async () => {
  const box = memoryDeps([row(v1Token(B.address), B.address)]);
  const list = await payGet(
    get(`http://localhost/api/pay?to=${B.address}`, await walletHeaders(A, WALLET_ACTIONS.paymentsRead)),
    box.deps,
  );
  assert.equal(list.status, 404);
  assert.equal(errorCode(list.body), "not_found");
  const statement = await statementGet(
    get(
      `http://localhost/api/statement?address=${B.address}`,
      await walletHeaders(A, WALLET_ACTIONS.paymentsRead, NOW, "http://localhost/api/statement", "GET"),
    ),
    box.deps,
  );
  assert.equal(statement.status, 404);
  assert.equal(box.calls.list + box.calls.find + box.calls.ledger, 0);
  assert.equal(JSON.stringify(list.body).includes(B.address.toLowerCase()), false);
});

test("P1-05 #21/#22: wallet-authenticated merchant reads only its own rows; planted rows are excluded", async () => {
  const mineV1 = v1Token(A.address);
  const mineV2 = (await v2Token(KEY_A, { merchant: A.address, requestByte: "41" })).token;
  // Rows that could only exist from pre-fix injection or tampering: undecodable, mismatched V2,
  // and a stored "to" that disagrees with the token's payee.
  const box = memoryDeps([
    row(mineV1, A.address, { webhookUrl: STORED_HOOK }),
    row(mineV2, A.address),
    row("garbage-token", A.address),
    row(craftedMismatchV2(B.address, A.address, "42"), A.address),
    row(v1Token(B.address, "tampered"), A.address),
    row(v1Token(B.address), B.address),
  ]);
  const list = await payGet(
    get(`http://localhost/api/pay?to=${A.address.toLowerCase()}`, await walletHeaders(A, WALLET_ACTIONS.paymentsRead)),
    box.deps,
  );
  assert.equal(list.status, 200);
  const tokens = ("records" in list.body ? list.body.records : []).map((r) => r.token).sort();
  assert.deepEqual(tokens, [mineV1, mineV2].sort());
  assert.equal(JSON.stringify(list.body).includes(STORED_HOOK), false);
  const statement = await statementGet(
    get(
      `http://localhost/api/statement?address=${A.address}`,
      await walletHeaders(A, WALLET_ACTIONS.paymentsRead, NOW, "http://localhost/api/statement", "GET"),
    ),
    box.deps,
  );
  assert.equal(statement.status, 200);
  assert.deepEqual(("links" in statement.body ? statement.body.links : []).map((r) => r.token).sort(), [mineV1, mineV2].sort());
  assert.equal(box.calls.ledger, 1);
});

test("P1-05 #23: API-key access needs payment_requests:read; other scopes, agent keys, revoked and expired keys fail", async () => {
  const good = issueKey(A.address, ["payment_requests:read"]);
  const analyticsOnly = issueKey(A.address, ["analytics:read"]);
  const agent = issueKey(A.address, ["agent:read", "agent:write"]);
  const revoked = issueKey(A.address, ["payment_requests:read"], { revoked: true, enabled: false });
  const expired = issueKey(A.address, ["payment_requests:read"], { expiresAt: new Date((NOW - 10) * 1000).toISOString() });
  const box = memoryDeps([row(v1Token(A.address), A.address)], {
    keys: [good.record, analyticsOnly.record, agent.record, revoked.record, expired.record],
  });
  const call = (secret: string, to: Address = A.address) =>
    payGet(get(`http://localhost/api/pay?to=${to}`, { authorization: `Bearer ${secret}` }), box.deps);
  assert.equal((await call(good.secret)).status, 200);
  assert.equal((await call(good.secret, B.address)).status, 404);
  assert.equal((await call(analyticsOnly.secret)).status, 403);
  assert.equal((await call(agent.secret)).status, 403);
  assert.equal((await call(revoked.secret)).status, 401);
  assert.equal((await call(expired.secret)).status, 401);
  assert.equal((await call(generateApiSecret())).status, 401);
  resetApiKeyRateLimits();
});

test("P1-05 #24: /api/receipt/[hash] stays public chain proof — no store, no payment-request fields", () => {
  const route = src("src/app/api/receipt/[hash]/route.ts");
  assert.doesNotMatch(route, /payStore|getRecord|listByPayee|webhookUrl|payStatusHttp|reconcile/);
  assert.match(route, /verifyArcTransaction/);
  const proof = src("src/lib/arcProof.ts");
  assert.match(proof, /boundToRequest: false/);
  assert.doesNotMatch(proof, /from "\.\/payStore"|webhookUrl|views/);
});

test("P1-05 #24/#25: /api/receipt is rate limited per client per process", async () => {
  legacyRateLimiter.reset();
  // Force file pay-store backend so the shared Redis rate-limit counter is not consulted
  // (that bucket is shared across all local callers as ip:untrusted-proxy).
  const prevStore = process.env.FINAL_PAY_STORE;
  process.env.FINAL_PAY_STORE = join(tmpdir(), "final-receipt-rate-limit-force-file.json");
  try {
    const { GET } = await import("../app/api/receipt/[hash]/route");
    const ctx = { params: Promise.resolve({ hash: "0x12" }) };
    for (let i = 0; i < LEGACY_RATE_RULES["receipt.proof"].perKey; i += 1) {
      const res = await GET(new Request("http://localhost/api/receipt/0x12"), { params: Promise.resolve({ hash: "0x12" }) });
      assert.equal(res.status, 400);
    }
    const limited = await GET(new Request("http://localhost/api/receipt/0x12"), ctx);
    assert.equal(limited.status, 429);
  } finally {
    legacyRateLimiter.reset();
    if (prevStore === undefined) delete process.env.FINAL_PAY_STORE;
    else process.env.FINAL_PAY_STORE = prevStore;
  }
});

test("P1-05 #25: expensive legacy reads are rate limited before auth/store work and per merchant after auth", async () => {
  const deny = (cls: string) => (c: string) => c !== cls;
  const ipLimited = memoryDeps([], { limiter: deny("pay.list_ip") });
  const r1 = await payGet(get(`http://localhost/api/pay?to=${A.address}`, await walletHeaders(A, WALLET_ACTIONS.paymentsRead)), ipLimited.deps);
  assert.equal(r1.status, 429);
  assert.equal(ipLimited.calls.authorize + ipLimited.calls.list, 0);

  const merchantLimited = memoryDeps([], { limiter: deny("statement.merchant") });
  const r2 = await statementGet(
    get(`http://localhost/api/statement?address=${A.address}`, await walletHeaders(A, WALLET_ACTIONS.paymentsRead, NOW, "http://localhost/api/statement", "GET")),
    merchantLimited.deps,
  );
  assert.equal(r2.status, 429);
  assert.equal(merchantLimited.calls.authorize, 1);
  assert.equal(merchantLimited.calls.ledger + merchantLimited.calls.list, 0);

  const tokenLimited = memoryDeps([row(v1Token(A.address), A.address)], { limiter: deny("pay.token_read") });
  const r3 = await payGet(get(`http://localhost/api/pay?token=${encodeURIComponent(v1Token(A.address))}`), tokenLimited.deps);
  assert.equal(r3.status, 429);
  assert.equal(tokenLimited.calls.find, 0);
});

// ---------------------------------------------------------------------------
// P1-03 + P1-05 / P1-04 + P1-05 interaction
// ---------------------------------------------------------------------------

test("P1-03+P1-05 #26: an attacker cannot plant records and then trigger the victim's list", async () => {
  const box = memoryDeps();
  // Unsigned V1 plants for the victim are refused outright.
  for (let i = 0; i < 25; i += 1) {
    assert.equal((await payPost(post({ token: v1Token(A.address, `plant-${i}`) }), box.deps)).status, 401);
  }
  // V2 claiming the victim as merchant but signed by the attacker.
  for (let i = 0; i < 5; i += 1) {
    const forged = await v2Token(KEY_B, { merchant: A.address, requestByte: (80 + i).toString(16) });
    assert.equal((await payPost(post({ token: forged.token }), box.deps)).status, 400);
  }
  // V2 naming the victim as recipient under the attacker's merchant: not a canonical request.
  assert.equal((await payPost(post({ token: craftedMismatchV2(B.address, A.address) }), box.deps)).status, 400);
  assert.equal(box.records.size, 0);
  assert.equal(countPayRecordsOwnedBy(box.records.values(), A.address), 0, "no plants consume the victim's cap");
  const unauth = await payGet(get(`http://localhost/api/pay?to=${A.address}`), box.deps);
  assert.equal(unauth.status, 401);
  assert.equal(box.calls.find, 0, "no reconciliation fan-out for an unauthenticated caller");
  const own = await payGet(get(`http://localhost/api/pay?to=${A.address}`, await walletHeaders(A, WALLET_ACTIONS.paymentsRead)), box.deps);
  assert.equal(own.status, 200);
  assert.deepEqual("records" in own.body ? own.body.records : null, []);
  assert.equal(box.calls.find, 0);
});

test("P1-03 #27: malicious registrations cannot cause merchant-side webhook effects", async () => {
  const box = memoryDeps();
  for (let i = 0; i < 20; i += 1) await payPost(post({ token: v1Token(A.address, `x-${i}`) }), box.deps);
  const forged = await v2Token(KEY_B, { merchant: A.address, requestByte: "61" });
  await payPost(post({ token: forged.token }), box.deps);
  await payPost(post({ token: craftedMismatchV2(B.address, A.address, "62") }), box.deps);
  await payPost(await signedPostPay(B, { token: v1Token(A.address, "cross"), action: "register" }), box.deps);
  assert.equal(box.emitted.length, 0);
  // A genuine public V2 link replayed many times emits exactly once.
  const genuine = await v2Token(KEY_A, { merchant: A.address, requestByte: "63" });
  for (let i = 0; i < 10; i += 1) await payPost(post({ token: genuine.token }), box.deps);
  assert.equal(box.emitted.length, 1);
});

// ---------------------------------------------------------------------------
// rate limiter, client identity, wallet header reuse
// ---------------------------------------------------------------------------

test("rate limiter: per-key and global ceilings, denied calls not counted, window resets, map bounded", () => {
  let now = 1_000;
  const limiter = new FixedWindowLimiter({ r: { perKey: 2, global: 3, windowSeconds: 60 } }, () => now);
  assert.equal(limiter.allow("r", "a"), true);
  assert.equal(limiter.allow("r", "a"), true);
  assert.equal(limiter.allow("r", "a"), false);
  assert.equal(limiter.allow("r", "b"), true);
  assert.equal(limiter.allow("r", "c"), false, "global ceiling");
  for (let i = 0; i < 5_000; i += 1) limiter.allow("r", `rotating-${i}`);
  assert.ok(limiter.size() <= 4, `bounded map, got ${limiter.size()}`);
  now += 60;
  assert.equal(limiter.allow("r", "a"), true);
  assert.equal(limiter.allow("unknown" as "r", "a"), false, "unknown class fails closed");
});

test("client identity: forwarded headers are ignored off Vercel; Vercel platform headers are used", () => {
  const spoofed = new Request("http://localhost", { headers: { "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" } });
  assert.equal(requestClientKey(spoofed, {}), "ip:untrusted-proxy");
  const vercel = new Request("http://localhost", { headers: { "x-vercel-forwarded-for": "9.9.9.9", "x-forwarded-for": "1.1.1.1" } });
  assert.equal(requestClientKey(vercel, { VERCEL: "1" }), "ip:9.9.9.9");
  const junk = new Request("http://localhost", { headers: { "x-real-ip": "not an ip<script>" } });
  assert.equal(requestClientKey(junk, { VERCEL: "1" }), "ip:unknown");
});

test("wallet header signing: each call uses a fresh single-use nonce (P2-01)", async () => {
  let prompts = 0;
  const sign = async ({ message }: { message: string }) => {
    prompts += 1;
    return A.signMessage({ message });
  };
  const t0 = Date.now();
  const a = await cachedWalletHeaders(WALLET_ACTIONS.paymentsRead, A.address, sign, { method: "GET", path: "/api/pay" }, t0);
  const b = await cachedWalletHeaders(WALLET_ACTIONS.paymentsRead, A.address, sign, { method: "GET", path: "/api/pay" }, t0);
  assert.notEqual(a[WALLET_AUTH_HEADERS.nonce], b[WALLET_AUTH_HEADERS.nonce]);
  assert.equal(prompts, 2);
  await cachedWalletHeaders(WALLET_ACTIONS.paymentsRegister, A.address, sign, {
    method: "POST",
    path: "/api/pay",
    body: JSON.stringify({ token: "x", action: "register" }),
  }, t0);
  assert.equal(prompts, 3);
});

// ---------------------------------------------------------------------------
// boundaries that must not regress
// ---------------------------------------------------------------------------

test("analytics and checkout isolation are unchanged; dashboard callers send wallet auth", () => {
  const merchantData = src("src/components/dashboard/MerchantData.tsx");
  assert.match(merchantData, /pathname === "\/dashboard\/analytics"/);
  assert.match(merchantData, /if \(!merchant \|\| skipPaymentList\) return;/);
  // Merchant-private reads go through the workspace session (wallet-authorized, one sign-in).
  assert.match(merchantData, /workspaceFetch\(`\/api\/pay\?to=/);
  const analyticsPanel = src("src/components/dashboard/AnalyticsPanel.tsx");
  assert.doesNotMatch(analyticsPanel, /\/api\/pay|\/api\/statement/);
  assert.match(src("src/components/Statement.tsx"), /workspaceFetch\(`\/api\/statement\?address=/);
  assert.match(src("src/components/HistoryList.tsx"), /workspaceFetch\(`\/api\/pay\?to=/);
  assert.doesNotMatch(src("src/components/RequestForm.tsx"), /webhookUrl/);
  const checkout = src("src/components/Checkout.tsx");
  assert.match(checkout, /\/api\/pay\/observe\?token=/);
  assert.doesNotMatch(checkout, /action: "register"|action: "view"/);
});

test("Phase 14: legacy GETs are pure; submit/reconcile own settlement", () => {
  const legacy = src("src/lib/payStatusHttp.ts");
  assert.doesNotMatch(legacy, /withPaid|reconcilePaymentRecord\(/);
  assert.match(legacy, /submitTransactionHash|submitHash/);
  assert.match(legacy, /reconcileOnePayment|reconcileOne/);
  assert.match(legacy, /resolveCancellation\(/);
  assert.match(legacy, /action === "submit"/);
  assert.match(legacy, /action === "reconcile"/);
  for (const file of ["src/lib/publicRateLimit.ts", "src/lib/resourceLimits.ts", "src/lib/walletAuthCache.ts", "src/lib/legacyLinkSync.ts"]) {
    const text = src(file);
    assert.doesNotMatch(text, /reconcilePaymentRecord|markPaid|findSettlementProof|emitWebhookEvent|writePayStoreBlob|mutatePayStoreBlob|createPublicClient|signTypedData|sendTransaction|privateKey/, file);
  }
});
