import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveMemoId } from "./finalRequest";
import { encodeV2PayRequest } from "./payRequest";
import { getRecord, upsertRecord, type PayRecord } from "./payStore";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  emitWebhookEvent,
  getWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  paymentRequestEventData,
  processDueWebhookDeliveries,
  retryDelaySeconds,
  sendWebhookTest,
  signWebhookBody,
  updateWebhookEndpoint,
  validateWebhookUrl,
  verifyWebhookSignature,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookDeps,
} from "./webhooks";

const MERCHANT = getAddress("0x00000000000000000000000000000000000000a1");
const OTHER = getAddress("0x00000000000000000000000000000000000000b2");
const ENV_KEYS = [
  "FINAL_PAY_STORE",
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

type FetchCall = { url: string; headers: Record<string, string>; body: string };

function mockDeps(opts?: {
  status?: number;
  failTimes?: number;
  now?: { value: number };
  onFetch?: (call: FetchCall) => void;
}): { deps: WebhookDeps; calls: FetchCall[]; secrets: string[] } {
  const calls: FetchCall[] = [];
  const secrets: string[] = [];
  let failsLeft = opts?.failTimes ?? 0;
  let seq = 0;
  const now = opts?.now ?? { value: 1_700_000_000 };
  const deps: WebhookDeps = {
    nowSeconds: () => now.value,
    caller: MERCHANT,
    randomId: (prefix) => `${prefix}_${(++seq).toString(16).padStart(8, "0")}`,
    createSecret: () => {
      const secret = `whsec_test_${secrets.length + 1}`;
      secrets.push(secret);
      return secret;
    },
    fetch: async (url, init) => {
      const call: FetchCall = {
        url,
        headers: init.headers,
        body: init.body,
      };
      calls.push(call);
      opts?.onFetch?.(call);
      if (failsLeft > 0) {
        failsLeft -= 1;
        throw new Error("network down");
      }
      return new Response(null, { status: opts?.status ?? 200 });
    },
  };
  return { deps, calls, secrets };
}

async function withStore(fn: (deps: ReturnType<typeof mockDeps>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "final-webhooks-"));
  const path = join(dir, "pay-store.json");
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.FINAL_PAY_STORE = path;
  await writeFile(path, JSON.stringify({ records: {} }));
  try {
    await fn(mockDeps());
  } finally {
    restoreEnv();
    await rm(dir, { recursive: true, force: true });
  }
}

function row(over: Partial<PayRecord> = {}): PayRecord {
  return {
    token: "v1tok",
    id: "legacy",
    to: MERCHANT,
    amount: "1.25",
    memo: "INV-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    views: 0,
    lastViewedAt: null,
    cancelled: false,
    cancelledAt: null,
    paidTx: null,
    webhookUrl: null,
    ...over,
  };
}

test("create webhook returns secret once; later get omits secret", async () => {
  await withStore(async ({ deps, secrets }) => {
    const created = await createWebhookEndpoint(
      {
        merchant: MERCHANT,
        url: "https://hooks.example.com/final",
        events: ["payment_request.created"],
      },
      deps,
    );
    assert.equal(created.status, 200);
    const body = created.body as { id: string; secret?: string; secretSet?: boolean };
    assert.equal(body.secret, secrets[0]);
    assert.equal(body.secretSet, true);

    const got = await getWebhookEndpoint(body.id, MERCHANT, deps);
    assert.equal(got.status, 200);
    assert.equal("secret" in got.body, false);
    assert.equal((got.body as { secretSet: true }).secretSet, true);
  });
});

test("list webhooks is merchant-scoped", async () => {
  await withStore(async ({ deps }) => {
    await createWebhookEndpoint(
      { merchant: MERCHANT, url: "https://a.example.com/h", events: ["payment_request.created"] },
      deps,
    );
    await createWebhookEndpoint(
      { merchant: OTHER, url: "https://b.example.com/h", events: ["payment_request.cancelled"] },
      { ...deps, caller: OTHER },
    );
    const mine = await listWebhookEndpoints(MERCHANT, deps);
    assert.equal(mine.status, 200);
    const endpoints = (mine.body as { endpoints: { merchant: string }[] }).endpoints;
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0].merchant, MERCHANT);
  });
});

test("cross-merchant get returns not_found", async () => {
  await withStore(async ({ deps }) => {
    const created = await createWebhookEndpoint(
      { merchant: MERCHANT, url: "https://a.example.com/h", events: ["webhook.test"] },
      deps,
    );
    const id = (created.body as { id: string }).id;
    const denied = await getWebhookEndpoint(id, OTHER, deps);
    assert.equal(denied.status, 404);
    assert.equal((denied.body as { error: { code: string } }).error.code, "not_found");
  });
});

test("update enable/disable and rotate secret", async () => {
  await withStore(async ({ deps, secrets }) => {
    const created = await createWebhookEndpoint(
      { merchant: MERCHANT, url: "https://a.example.com/h", events: ["payment_request.created"] },
      deps,
    );
    const id = (created.body as { id: string }).id;
    const disabled = await updateWebhookEndpoint(id, { merchant: MERCHANT, enabled: false }, deps);
    assert.equal(disabled.status, 200);
    assert.equal((disabled.body as { enabled: boolean }).enabled, false);
    assert.equal("secret" in disabled.body, false);

    const rotated = await updateWebhookEndpoint(id, { merchant: MERCHANT, rotateSecret: true }, deps);
    assert.equal(rotated.status, 200);
    assert.equal((rotated.body as { secret: string }).secret, secrets[1]);
    assert.notEqual(secrets[0], secrets[1]);
  });
});

test("delete webhook", async () => {
  await withStore(async ({ deps }) => {
    const created = await createWebhookEndpoint(
      { merchant: MERCHANT, url: "https://a.example.com/h", events: ["webhook.test"] },
      deps,
    );
    const id = (created.body as { id: string }).id;
    const deleted = await deleteWebhookEndpoint(id, MERCHANT, deps);
    assert.equal(deleted.status, 200);
    const got = await getWebhookEndpoint(id, MERCHANT, deps);
    assert.equal(got.status, 404);
  });
});

test("invalid URL and unsupported protocol", () => {
  assert.throws(() => validateWebhookUrl("not-a-url"), /absolute https/);
  assert.throws(() => validateWebhookUrl("http://example.com/h"), /https/);
  assert.throws(() => validateWebhookUrl("https://user:pass@example.com/h"), /credentials/);
  assert.throws(() => validateWebhookUrl("https://localhost/h"), /not allowed/);
  assert.throws(() => validateWebhookUrl("https://127.0.0.1/h"), /not allowed/);
  assert.throws(() => validateWebhookUrl("https://10.0.0.5/h"), /not allowed/);
  assert.throws(() => validateWebhookUrl("https://192.168.1.1/h"), /not allowed/);
  assert.throws(() => validateWebhookUrl("https://169.254.169.254/latest"), /not allowed/);
  assert.equal(validateWebhookUrl("https://hooks.example.com/final"), "https://hooks.example.com/final");
});

test("create rejects invalid URL", async () => {
  await withStore(async ({ deps }) => {
    const bad = await createWebhookEndpoint(
      { merchant: MERCHANT, url: "http://example.com", events: ["payment_request.created"] },
      deps,
    );
    assert.equal(bad.status, 400);
    assert.equal((bad.body as { error: { code: string } }).error.code, "invalid_url");
  });
});

test("event envelope, unique eventId and deliveryId", async () => {
  await withStore(async () => {
    const { deps, calls } = mockDeps();
    await createWebhookEndpoint(
      {
        merchant: MERCHANT,
        url: "https://hooks.example.com/final",
        events: ["payment_request.created"],
      },
      deps,
    );
    const first = await emitWebhookEvent(
      { type: "payment_request.created", merchant: MERCHANT, data: { token: "t1" } },
      deps,
    );
    const second = await emitWebhookEvent(
      { type: "payment_request.created", merchant: MERCHANT, data: { token: "t2" } },
      deps,
    );
    assert.notEqual(first.eventId, second.eventId);
    assert.notEqual(first.deliveries[0].deliveryId, second.deliveries[0].deliveryId);
    const body = JSON.parse(calls[0].body) as { id: string; type: string; merchant: string; data: { token: string } };
    assert.equal(body.type, "payment_request.created");
    assert.equal(body.merchant, MERCHANT);
    assert.equal(body.data.token, "t1");
    assert.equal(body.id, first.eventId);
  });
});

test("HMAC signature generation and verification", () => {
  const secret = "whsec_abc";
  const raw = '{"id":"evt_1"}';
  const ts = 1_700_000_000;
  const sig = signWebhookBody(secret, ts, raw);
  const expected = createHmac("sha256", secret).update(`${ts}.${raw}`, "utf8").digest("hex");
  assert.equal(sig, expected);
  assert.equal(
    verifyWebhookSignature({ secret, timestamp: ts, rawBody: raw, signature: sig, nowSeconds: ts }),
    true,
  );
  assert.equal(
    verifyWebhookSignature({ secret, timestamp: ts, rawBody: raw, signature: "deadbeef", nowSeconds: ts }),
    false,
  );
  assert.equal(
    verifyWebhookSignature({
      secret,
      timestamp: ts,
      rawBody: '{"id":"evt_2"}',
      signature: sig,
      nowSeconds: ts,
    }),
    false,
  );
  assert.equal(
    verifyWebhookSignature({
      secret,
      timestamp: ts,
      rawBody: raw,
      signature: sig,
      nowSeconds: ts + 301,
    }),
    false,
  );
});

test("delivery signs with required headers", async () => {
  await withStore(async () => {
    const { deps, calls, secrets } = mockDeps();
    await createWebhookEndpoint(
      { merchant: MERCHANT, url: "https://hooks.example.com/final", events: ["webhook.test"] },
      deps,
    );
    const list = await listWebhookEndpoints(MERCHANT, deps);
    const id = (list.body as { endpoints: { id: string }[] }).endpoints[0].id;
    await sendWebhookTest(id, MERCHANT, deps);
    assert.equal(calls.length, 1);
    const headers = calls[0].headers;
    assert.ok(headers["X-Final-Webhook-Id"]);
    assert.ok(headers["X-Final-Webhook-Timestamp"]);
    assert.ok(headers["X-Final-Webhook-Signature"]);
    assert.equal(
      verifyWebhookSignature({
        secret: secrets[0],
        timestamp: headers["X-Final-Webhook-Timestamp"],
        rawBody: calls[0].body,
        signature: headers["X-Final-Webhook-Signature"],
        nowSeconds: 1_700_000_000,
      }),
      true,
    );
    const envelope = JSON.parse(calls[0].body) as { type: string };
    assert.equal(envelope.type, "webhook.test");
  });
});

test("successful delivery and non-2xx retry scheduling", async () => {
  await withStore(async () => {
    const now = { value: 1_700_000_000 };
    const { deps, calls } = mockDeps({ status: 500, now });
    await createWebhookEndpoint(
      { merchant: MERCHANT, url: "https://hooks.example.com/final", events: ["payment_request.created"] },
      deps,
    );
    const emitted = await emitWebhookEvent(
      { type: "payment_request.created", merchant: MERCHANT, data: { token: "t" } },
      deps,
    );
    assert.equal(emitted.deliveries[0].status, "retrying");
    assert.equal(emitted.deliveries[0].httpStatus, 500);
    assert.equal(emitted.deliveries[0].nextRetryAt, new Date((now.value + 60) * 1000).toISOString());
    assert.equal(calls.length, 1);

    now.value += 60;
    const okDeps = mockDeps({ status: 200, now });
    // reuse ids/secrets by copying fetch only — processDue needs same store endpoint secret
    const retried = await processDueWebhookDeliveries({
      ...deps,
      nowSeconds: () => now.value,
      fetch: okDeps.deps.fetch,
    });
    assert.equal(retried.length, 1);
    assert.equal(retried[0].status, "success");
    assert.equal(retried[0].eventId, emitted.eventId);
    assert.notEqual(retried[0].deliveryId, emitted.deliveries[0].deliveryId);
    assert.equal(retried[0].attempt, 2);
  });
});

test("bounded retries then failed", async () => {
  await withStore(async () => {
    const now = { value: 1_700_000_000 };
    const { deps } = mockDeps({ failTimes: 99, now });
    await createWebhookEndpoint(
      { merchant: MERCHANT, url: "https://hooks.example.com/final", events: ["payment_request.created"] },
      deps,
    );
    let last = await emitWebhookEvent(
      { type: "payment_request.created", merchant: MERCHANT, data: {} },
      deps,
    );
    assert.equal(last.deliveries[0].status, "retrying");
    for (let attempt = 2; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      const delay = retryDelaySeconds(attempt - 1);
      assert.ok(delay != null);
      now.value += delay!;
      const batch = await processDueWebhookDeliveries(deps);
      assert.equal(batch.length, 1);
      last = { eventId: batch[0].eventId, deliveries: batch };
      if (attempt < WEBHOOK_MAX_ATTEMPTS) assert.equal(batch[0].status, "retrying");
      else assert.equal(batch[0].status, "failed");
    }
    now.value += 3600;
    const none = await processDueWebhookDeliveries(deps);
    assert.equal(none.length, 0);
  });
});

test("payment.paid is not emitted", async () => {
  await withStore(async ({ deps }) => {
    await assert.rejects(
      () =>
        emitWebhookEvent(
          { type: "payment.paid" as "payment_request.created", merchant: MERCHANT, data: {} },
          deps,
        ),
      /not emitted/,
    );
  });
});

test("webhook failure does not mutate payment row", async () => {
  await withStore(async () => {
    const path = process.env.FINAL_PAY_STORE!;
    const before = row({ token: "keep", paidTx: null, cancelled: false });
    await upsertRecord(before);
    const { deps } = mockDeps({ failTimes: 5 });
    await createWebhookEndpoint(
      { merchant: MERCHANT, url: "https://hooks.example.com/final", events: ["payment_request.created"] },
      deps,
    );
    await emitWebhookEvent(
      { type: "payment_request.created", merchant: MERCHANT, data: paymentRequestEventData(before) },
      deps,
    );
    const after = await getRecord("keep");
    assert.deepEqual(after, before);
    const blob = JSON.parse(await readFile(path, "utf8")) as {
      records: Record<string, PayRecord>;
      webhooks?: { endpoints: Record<string, unknown> };
    };
    assert.equal(blob.records.keep.cancelled, false);
    assert.equal(blob.records.keep.paidTx, null);
    assert.ok(blob.webhooks?.endpoints);
  });
});

test("V1 payload omits requestId and memoId; V2 includes them when present", async () => {
  const v1 = paymentRequestEventData(row());
  assert.equal("requestId" in v1, false);
  assert.equal("memoId" in v1, false);
  assert.equal(v1.amountBaseUnits, "1250000");
  assert.equal(v1.memo, "INV-1");

  const unknown = paymentRequestEventData(row({ token: "not-a-real-token", amount: "2.00" }));
  assert.equal("requestId" in unknown, false);
  assert.equal("memoId" in unknown, false);
  assert.equal(unknown.amountBaseUnits, "2000000");

  const account = privateKeyToAccount(
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  );
  const requestId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const token = encodeV2PayRequest({
    version: 2,
    requestId,
    merchant: account.address,
    recipient: account.address,
    amountBaseUnits: 1000000n,
    memo: "V2-MEMO",
    chainId: 5042,
    expiresAt: 2_000_000_000,
    nonce: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    signature: ("0x" + "11".repeat(65)) as `0x${string}`,
  });
  const v2 = paymentRequestEventData(
    row({ token, to: account.address, amount: "1.00", memo: "V2-MEMO", id: requestId }),
  );
  assert.equal(v2.requestId, requestId);
  assert.equal(v2.memoId, deriveMemoId(requestId));
  assert.equal(v2.amountBaseUnits, "1000000");
  assert.equal(v2.expiresAt, 2_000_000_000);
});

test("deliveries list hides body and requires merchant", async () => {
  await withStore(async () => {
    const { deps } = mockDeps();
    const created = await createWebhookEndpoint(
      { merchant: MERCHANT, url: "https://hooks.example.com/final", events: ["webhook.test"] },
      deps,
    );
    const id = (created.body as { id: string }).id;
    await sendWebhookTest(id, MERCHANT, deps);
    const listed = await listWebhookDeliveries(id, MERCHANT, deps);
    assert.equal(listed.status, 200);
    const deliveries = (listed.body as { deliveries: Record<string, unknown>[] }).deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal("body" in deliveries[0], false);
    const denied = await listWebhookDeliveries(id, OTHER, deps);
    assert.equal(denied.status, 404);
  });
});

test("eventId deduplication semantics: retries keep eventId", async () => {
  await withStore(async () => {
    const now = { value: 1_700_000_000 };
    const { deps } = mockDeps({ status: 503, now });
    await createWebhookEndpoint(
      { merchant: MERCHANT, url: "https://hooks.example.com/final", events: ["payment_request.created"] },
      deps,
    );
    const emitted = await emitWebhookEvent(
      { type: "payment_request.created", merchant: MERCHANT, data: {} },
      deps,
    );
    now.value += 60;
    const again = await processDueWebhookDeliveries({
      ...deps,
      fetch: async () => new Response(null, { status: 200 }),
    });
    assert.equal(again[0].eventId, emitted.eventId);
  });
});

test("reconciliation and matching files were not modified by webhooks", async () => {
  const roots = [
    "src/lib/reconcilePayment.ts",
    "src/lib/payPaid.ts",
    "src/lib/receipt.ts",
    "src/lib/finalRequest.ts",
  ];
  for (const file of roots) {
    const text = await readFile(join(process.cwd(), file), "utf8");
    assert.equal(text.includes("emitWebhookEvent"), false);
    assert.equal(text.includes("emitPaymentRequest"), false);
  }
  const phase = await readFile(join(process.cwd(), "src/lib/payRequest.ts"), "utf8");
  assert.match(phase, /export function paymentLinkPhase/);
  assert.equal(phase.includes("emitWebhook"), false);
  const store = await readFile(join(process.cwd(), "src/lib/payStore.ts"), "utf8");
  assert.match(store, /export async function markPaid/);
  assert.match(store, /deriveMemoId|isV2RequestId/);
  // deriveMemoId still lives in finalRequest; payment identity still keyed by token.
  assert.match(store, /store\.records\[record\.token\]/);
});

test("old store blob without webhooks key still loads payments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "final-webhooks-old-"));
  const path = join(dir, "pay-store.json");
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.FINAL_PAY_STORE = path;
  await writeFile(
    path,
    JSON.stringify({ records: { tok: row({ token: "tok", amount: "3.00" }) } }),
  );
  try {
    const got = await getRecord("tok");
    assert.equal(got?.amount, "3.00");
    const { deps } = mockDeps();
    await createWebhookEndpoint(
      { merchant: MERCHANT, url: "https://hooks.example.com/final", events: ["webhook.test"] },
      deps,
    );
    const again = await getRecord("tok");
    assert.equal(again?.amount, "3.00");
    const blob = JSON.parse(await readFile(path, "utf8")) as {
      records: Record<string, PayRecord>;
      webhooks?: { endpoints: Record<string, unknown> };
    };
    assert.ok(blob.webhooks?.endpoints);
    assert.equal(blob.records.tok.amount, "3.00");
  } finally {
    restoreEnv();
    await rm(dir, { recursive: true, force: true });
  }
});

test("timingSafeEqual path rejects different-length signatures without throw", () => {
  assert.equal(
    verifyWebhookSignature({
      secret: "x",
      timestamp: 1,
      rawBody: "{}",
      signature: "ab",
      nowSeconds: 1,
    }),
    false,
  );
});
