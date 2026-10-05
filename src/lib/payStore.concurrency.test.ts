import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Address } from "viem";
import { asApiKeyRecord, liveApiKeyRuntime } from "./apiKeys";
import { createFakeRedis } from "./fakeRedisRest";
import {
  PAY_STORE_CAS_MAX_ATTEMPTS,
  PAY_STORE_KEY,
  PayStoreCasExhaustedError,
  PayStoreMalformedError,
  mutatePayStoreBlob,
  readPayStoreBlob,
  type StoreFile,
} from "./payStore";

const ENV_KEYS = [
  "FINAL_PAY_STORE",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
const originalFetch = globalThis.fetch;

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

function activeKey(id = "key_1"): Record<string, unknown> {
  return {
    id,
    merchant: "0xf118AF312c8D4BB37a1ab3f67A86D1C3Ab6F86bb",
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

function installFake(redis: ReturnType<typeof createFakeRedis>): void {
  process.env.KV_REST_API_URL = "https://kv.fake";
  process.env.KV_REST_API_TOKEN = "token";
  globalThis.fetch = redis.fetch as typeof fetch;
}

async function seed(redis: ReturnType<typeof createFakeRedis>, store: StoreFile): Promise<void> {
  redis.values.set(PAY_STORE_KEY, JSON.stringify(store));
}

test("A: concurrent unrelated mutations both survive", () =>
  withEnv(async () => {
    const redis = createFakeRedis();
    installFake(redis);
    const base = emptyStore();
    base.apiKeys = { keys: { key_1: activeKey() } };
    await seed(redis, base);

    await Promise.all([
      mutatePayStoreBlob((store) => {
        const key = asApiKeyRecord(store.apiKeys!.keys.key_1)!;
        key.revoked = true;
        key.enabled = false;
        store.apiKeys!.keys.key_1 = key;
      }),
      mutatePayStoreBlob((store) => {
        store.webhooks = store.webhooks ?? { endpoints: {}, deliveries: {} };
        store.webhooks.endpoints.wh_new = {
          id: "wh_new",
          merchant: "0xf118AF312c8D4BB37a1ab3f67A86D1C3Ab6F86bb",
          url: "https://example.com/hook",
          enabled: true,
          events: ["payment_request.created"],
          secret: "whsec_test",
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        };
      }),
    ]);

    const final = await readPayStoreBlob();
    const key = asApiKeyRecord(final.apiKeys!.keys.key_1)!;
    assert.equal(key.revoked, true);
    assert.equal(key.enabled, false);
    assert.ok(final.webhooks?.endpoints.wh_new);
    assert.ok(redis.conflictsReturned >= 0);
  }),
);

test("B: revoke wins over concurrent touchLastUsed", () =>
  withEnv(async () => {
    const redis = createFakeRedis();
    installFake(redis);
    const base = emptyStore();
    base.apiKeys = { keys: { key_1: activeKey() } };
    await seed(redis, base);

    // Force the touch path to lose the first CAS so it retries against revoked state.
    redis.injectConflicts(1);
    const touch = mutatePayStoreBlob((store) => {
      const current = asApiKeyRecord(store.apiKeys!.keys.key_1);
      if (!current || current.revoked || !current.enabled) return;
      current.lastUsedAt = "2026-03-01T00:00:00.000Z";
      store.apiKeys!.keys.key_1 = current;
    });
    const revoke = mutatePayStoreBlob((store) => {
      const current = asApiKeyRecord(store.apiKeys!.keys.key_1)!;
      current.revoked = true;
      current.enabled = false;
      store.apiKeys!.keys.key_1 = current;
    });
    await Promise.all([revoke, touch]);

    const final = await readPayStoreBlob();
    const key = asApiKeyRecord(final.apiKeys!.keys.key_1)!;
    assert.equal(key.revoked, true);
    assert.equal(key.enabled, false);
    // live runtime touch mirrors the same invariant
    const runtime = liveApiKeyRuntime();
    await runtime.touchLastUsed("key_1", "2026-04-01T00:00:00.000Z");
    const after = asApiKeyRecord((await readPayStoreBlob()).apiKeys!.keys.key_1)!;
    assert.equal(after.revoked, true);
    assert.equal(after.lastUsedAt, key.lastUsedAt);
  }),
);

test("C: webhook delete is not resurrected by stale update", () =>
  withEnv(async () => {
    const redis = createFakeRedis();
    installFake(redis);
    const base = emptyStore();
    base.webhooks = {
      endpoints: {
        wh_1: {
          id: "wh_1",
          merchant: "0xf118AF312c8D4BB37a1ab3f67A86D1C3Ab6F86bb",
          url: "https://example.com/a",
          enabled: true,
          events: ["payment_request.created"],
          secret: "whsec_a",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      deliveries: {},
    };
    await seed(redis, base);

    redis.injectConflicts(1);
    const staleUpdate = mutatePayStoreBlob((store) => {
      const row = store.webhooks?.endpoints.wh_1 as { url?: string; updatedAt?: string } | undefined;
      if (!row) return; // delete won
      row.url = "https://example.com/stale";
      row.updatedAt = "2026-05-01T00:00:00.000Z";
    });
    const del = mutatePayStoreBlob((store) => {
      delete store.webhooks!.endpoints.wh_1;
    });
    await Promise.all([del, staleUpdate]);
    const final = await readPayStoreBlob();
    assert.equal(final.webhooks?.endpoints.wh_1, undefined);
  }),
);

test("D: agent VERIFIED never downgrades to FAILED or SUBMITTED", () =>
  withEnv(async () => {
    const redis = createFakeRedis();
    installFake(redis);
    const base = emptyStore();
    base.agents = {
      intents: {
        intent_1: {
          intentId: "intent_1",
          requestId: "intent_1",
          merchant: "0xf118AF312c8D4BB37a1ab3f67A86D1C3Ab6F86bb",
          createdAt: "2026-01-01T00:00:00.000Z",
          status: "AWAITING_PAYMENT",
          submittedTxHash: null,
          verifiedTxHash: null,
          failureReason: null,
          proofStatus: null,
          binding: { boundToIntent: false, reason: null },
          proof: null,
          amountBaseUnits: "1000000",
          verifiedAt: null,
        },
      },
      idempotency: {},
    };
    await seed(redis, base);

    function merge(existing: { status?: string } | undefined, incoming: { status: string }) {
      if (existing?.status === "VERIFIED" && incoming.status !== "VERIFIED") return existing;
      return incoming;
    }

    redis.injectConflicts(1);
    await Promise.all([
      mutatePayStoreBlob((store) => {
        const cur = store.agents!.intents.intent_1 as { status: string };
        store.agents!.intents.intent_1 = merge(cur, {
          ...(cur as object),
          status: "VERIFIED",
          verifiedTxHash: "0xabc",
          verifiedAt: 1_700_000_000,
        } as never);
      }),
      mutatePayStoreBlob((store) => {
        const cur = store.agents!.intents.intent_1 as { status: string };
        store.agents!.intents.intent_1 = merge(cur, {
          ...(cur as object),
          status: "FAILED",
          failureReason: "mismatch",
        } as never);
      }),
    ]);
    const final = await readPayStoreBlob();
    assert.equal((final.agents!.intents.intent_1 as { status: string }).status, "VERIFIED");

    await mutatePayStoreBlob((store) => {
      const cur = store.agents!.intents.intent_1 as { status: string };
      store.agents!.intents.intent_1 = merge(cur, { ...(cur as object), status: "SUBMITTED" } as never);
    });
    assert.equal(((await readPayStoreBlob()).agents!.intents.intent_1 as { status: string }).status, "VERIFIED");
  }),
);

test("E: escrow FUNDED is not regressed to CREATED", () =>
  withEnv(async () => {
    const redis = createFakeRedis();
    installFake(redis);
    const base = emptyStore();
    base.escrows = {
      records: {
        esc_1: {
          escrowId: "0x" + "11".repeat(32),
          state: "FUNDED",
          creator: "0xf118AF312c8D4BB37a1ab3f67A86D1C3Ab6F86bb",
          amountBaseUnits: "1",
        },
      },
    };
    await seed(redis, base);

    const rank: Record<string, number> = {
      CREATED: 0,
      OPEN: 1,
      FUNDED: 2,
      RELEASED: 3,
      REFUNDED: 3,
      CANCELLED: 3,
    };
    const escrowKey = Object.keys(base.escrows!.records)[0]!;
    await mutatePayStoreBlob((store) => {
      const existing = store.escrows!.records[escrowKey] as { state: string };
      const incoming = { ...existing, state: "CREATED" };
      if (rank[incoming.state]! < rank[existing.state]!) return;
      store.escrows!.records[escrowKey] = incoming;
    });
    assert.equal(((await readPayStoreBlob()).escrows!.records[escrowKey] as { state: string }).state, "FUNDED");
  }),
);

test("F: idempotency row survives unrelated mutation and CAS retry", () =>
  withEnv(async () => {
    const redis = createFakeRedis();
    installFake(redis);
    const base = emptyStore();
    base.agents = {
      intents: {},
      idempotency: {
        idem_1: {
          merchant: "0xf118AF312c8D4BB37a1ab3f67A86D1C3Ab6F86bb",
          route: "POST /x",
          key: "k1",
          bodyHash: "hash-a",
          status: 200,
          body: { ok: true },
        },
      },
    };
    await seed(redis, base);

    redis.injectConflicts(2);
    await mutatePayStoreBlob((store) => {
      store.apiKeys = store.apiKeys ?? { keys: {} };
      store.apiKeys.keys.key_x = activeKey("key_x");
    });
    const final = await readPayStoreBlob();
    assert.deepEqual(final.agents!.idempotency.idem_1, base.agents!.idempotency.idem_1);
    assert.ok(final.apiKeys!.keys.key_x);

    // Different body hash must not overwrite existing row (first wins).
    await mutatePayStoreBlob((store) => {
      const existing = store.agents!.idempotency.idem_1 as { bodyHash: string } | undefined;
      if (existing) return;
      store.agents!.idempotency.idem_1 = { ...(base.agents!.idempotency.idem_1 as object), bodyHash: "hash-b" };
    });
    assert.equal(((await readPayStoreBlob()).agents!.idempotency.idem_1 as { bodyHash: string }).bodyHash, "hash-a");
  }),
);

test("G: forced CAS conflict retries against fresh state", () =>
  withEnv(async () => {
    const redis = createFakeRedis();
    installFake(redis);
    await seed(redis, emptyStore());
    redis.injectConflicts(3);
    let attempts = 0;
    await mutatePayStoreBlob((store) => {
      attempts += 1;
      store.records.tok = {
        token: "tok",
        id: "legacy",
        to: "0xf118AF312c8D4BB37a1ab3f67A86D1C3Ab6F86bb" as Address,
        amount: "1.00",
        memo: "m",
        createdAt: "2026-01-01T00:00:00.000Z",
        views: 0,
        lastViewedAt: null,
        cancelled: false,
        cancelledAt: null,
        paidTx: null,
        webhookUrl: null,
      };
    });
    assert.equal(attempts, 4); // 3 conflicts + 1 success
    assert.equal(redis.conflictsReturned, 3);
    assert.ok((await readPayStoreBlob()).records.tok);
  }),
);

test("H: CAS exhaustion fails closed with typed error and no unconditional SET", () =>
  withEnv(async () => {
    const redis = createFakeRedis();
    installFake(redis);
    await seed(redis, emptyStore());
    redis.injectConflicts(PAY_STORE_CAS_MAX_ATTEMPTS + 2);
    const before = redis.values.get(PAY_STORE_KEY);
    await assert.rejects(
      () =>
        mutatePayStoreBlob((store) => {
          store.records.x = {
            token: "x",
            id: "x",
            to: "0xf118AF312c8D4BB37a1ab3f67A86D1C3Ab6F86bb" as Address,
            amount: "1",
            memo: "",
            createdAt: "2026-01-01T00:00:00.000Z",
            views: 0,
            lastViewedAt: null,
            cancelled: false,
            cancelledAt: null,
            paidTx: null,
            webhookUrl: null,
          };
        }),
      (err: unknown) => err instanceof PayStoreCasExhaustedError,
    );
    assert.equal(redis.values.get(PAY_STORE_KEY), before);
  }),
);

test("I: Redis failure fails closed without wiping", () =>
  withEnv(async () => {
    process.env.KV_REST_API_URL = "https://kv.fake";
    process.env.KV_REST_API_TOKEN = "token";
    const seeded = JSON.stringify(emptyStore());
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/get/")) {
        return new Response(JSON.stringify({ result: seeded }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ error: "down" }), { status: 503 });
      }
      return new Response("no", { status: 404 });
    }) as typeof fetch;

    await assert.rejects(() => mutatePayStoreBlob((store) => {
      store.records.z = {
        token: "z",
        id: "z",
        to: "0xf118AF312c8D4BB37a1ab3f67A86D1C3Ab6F86bb" as Address,
        amount: "1",
        memo: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        views: 0,
        lastViewedAt: null,
        cancelled: false,
        cancelledAt: null,
        paidTx: null,
        webhookUrl: null,
      };
    }));
  }),
);

test("J: malformed Redis value fails closed and does not write {}", () =>
  withEnv(async () => {
    process.env.KV_REST_API_URL = "https://kv.fake";
    process.env.KV_REST_API_TOKEN = "token";
    let posted = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/get/")) {
        return new Response(JSON.stringify({ result: "{not-json" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (init?.method === "POST") {
        posted = true;
        return new Response(JSON.stringify({ result: 1 }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    }) as typeof fetch;

    await assert.rejects(
      () => mutatePayStoreBlob((store) => {
        store.records.a = {
          token: "a",
          id: "a",
          to: "0xf118AF312c8D4BB37a1ab3f67A86D1C3Ab6F86bb" as Address,
          amount: "1",
          memo: "",
          createdAt: "2026-01-01T00:00:00.000Z",
          views: 0,
          lastViewedAt: null,
          cancelled: false,
          cancelledAt: null,
          paidTx: null,
          webhookUrl: null,
        };
      }),
      (err: unknown) => err instanceof PayStoreMalformedError,
    );
    assert.equal(posted, false);
  }),
);

test("K: file backend process-local CAS keeps both mutations", () =>
  withEnv(async () => {
    const dir = await mkdtemp(join(tmpdir(), "final-pay-cas-"));
    process.env.FINAL_PAY_STORE = join(dir, "pay-store.json");
    try {
      await writeFile(process.env.FINAL_PAY_STORE, JSON.stringify(emptyStore()));
      await Promise.all([
        mutatePayStoreBlob((store) => {
          store.apiKeys = store.apiKeys ?? { keys: {} };
          store.apiKeys.keys.key_1 = activeKey();
        }),
        mutatePayStoreBlob((store) => {
          store.webhooks = store.webhooks ?? { endpoints: {}, deliveries: {} };
          store.webhooks.endpoints.wh_1 = { id: "wh_1" };
        }),
      ]);
      const raw = await readFile(process.env.FINAL_PAY_STORE, "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      assert.ok(parsed.apiKeys?.keys.key_1);
      assert.ok(parsed.webhooks?.endpoints.wh_1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }),
);

test("L: analytics module stays read-only toward pay-store writers", async () => {
  const src = await readFile(new URL("./analytics.ts", import.meta.url), "utf8");
  const http = await readFile(new URL("./analyticsHttp.ts", import.meta.url), "utf8");
  assert.equal(/mutatePayStoreBlob|writePayStoreBlob|writeStore\s*\(/.test(src), false);
  assert.equal(/mutatePayStoreBlob|writePayStoreBlob/.test(http), false);
  assert.match(http, /readPayStoreBlob/);
  assert.match(src, /never writes the store/);
});
