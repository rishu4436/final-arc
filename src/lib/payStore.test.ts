import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Address, Hash } from "viem";
import { getRecord, markCancelled, markPaid, markViewed, upsertRecord, type PayRecord } from "./payStore";

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
const PAYEE = "0xf118AF312c8D4BB37a1ab3f67A86D1C3Ab6F86bb" as Address;
const TX = "0x79c4d96647c2415e2fe54c4f30a5558c70d9ba179721bbbed1504f6f04a87eaa" as Hash;
const TX_OTHER = "0xd2fbd9f76e89cea1d295826fc8ccb372fd589044a07aeba7260db2779045aa9c" as Hash;
const SECRET = "kv-secret-token";
const SECRET_HOST = "https://kv-secret.example.test";

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

function row(over: Partial<PayRecord> = {}): PayRecord {
  return {
    token: "tok",
    id: "legacy-id",
    to: PAYEE,
    amount: "1.00",
    memo: "memo",
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

type FetchCall = { url: string; method: string; body?: string };

function installFetch(handler: (call: FetchCall, index: number) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: FetchCall = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}

function kvBody(store: { records: Record<string, PayRecord> } | null, status = 200): Response {
  return new Response(JSON.stringify({ result: store == null ? null : JSON.stringify(store) }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function decodeSet(body: string | undefined): { records: Record<string, PayRecord> } {
  assert.equal(typeof body, "string");
  const inner = JSON.parse(body as string) as unknown;
  assert.equal(typeof inner, "string");
  return JSON.parse(inner as string) as { records: Record<string, PayRecord> };
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

const defaultStorePath = join(process.cwd(), "data", "pay-store.json");

async function withSentinel(fn: () => Promise<void>): Promise<void> {
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  const body = JSON.stringify({ records: { sentinel: row({ token: "sentinel", amount: "file-only" }) } });
  await writeFile(defaultStorePath, body);
  try {
    await fn();
    assert.equal(await readFile(defaultStorePath, "utf8"), body);
  } finally {
    await rm(defaultStorePath, { force: true });
  }
}

function assertNoSecret(message: string): void {
  assert.equal(message.includes(SECRET), false);
  assert.equal(message.includes(SECRET_HOST), false);
  assert.equal(message.includes("Bearer"), false);
}

let tail: Promise<void> = Promise.resolve();

function serial(name: string, fn: () => Promise<void>): void {
  test(name, () => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  });
}

serial("complete KV pair selects Redis and does not read the JSON file", () =>
  withEnv(async () => {
    process.env.KV_REST_API_URL = "https://kv.example.test";
    process.env.KV_REST_API_TOKEN = "kv-token";
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "upstash-token";
    await withSentinel(async () => {
      const calls = installFetch(() => kvBody({ records: { tok: row({ amount: "from-kv" }) } }));
      const got = await getRecord("tok");
      assert.equal(got?.amount, "from-kv");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, "https://kv.example.test/get/final-pay-store");
      assert.equal(calls[0]?.method, "GET");
    });
  }),
);

serial("complete Upstash pair selects Redis when KV is unset", () =>
  withEnv(async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example.test/";
    process.env.UPSTASH_REDIS_REST_TOKEN = "upstash-token";
    await withSentinel(async () => {
      const calls = installFetch(() => kvBody({ records: { tok: row({ amount: "from-upstash" }) } }));
      const got = await getRecord("tok");
      assert.equal(got?.amount, "from-upstash");
      assert.equal(calls[0]?.url, "https://upstash.example.test/get/final-pay-store");
    });
  }),
);

serial("incomplete Redis config uses the JSON file and does not call Redis", () =>
  withEnv(async () => {
    const halves: Record<string, string>[] = [
      { KV_REST_API_URL: "https://kv.example.test" },
      { KV_REST_API_TOKEN: "kv-token" },
      { UPSTASH_REDIS_REST_URL: "https://upstash.example.test" },
      { UPSTASH_REDIS_REST_TOKEN: "upstash-token" },
      { KV_REST_API_URL: "https://kv.example.test", UPSTASH_REDIS_REST_TOKEN: "upstash-token" },
      { UPSTASH_REDIS_REST_URL: "https://upstash.example.test", KV_REST_API_TOKEN: "kv-token" },
    ];
    for (const half of halves) {
      clearStoreEnv();
      const dir = await mkdtemp(join(tmpdir(), "final-pay-"));
      const path = join(dir, "pay-store.json");
      process.env.FINAL_PAY_STORE = path;
      for (const [key, value] of Object.entries(half)) process.env[key] = value;
      const calls = installFetch(() => {
        throw new Error("redis should not be called");
      });
      try {
        const saved = await upsertRecord(row({ amount: "file" }));
        assert.equal(saved.amount, "file");
        assert.equal((await getRecord("tok"))?.amount, "file");
        assert.equal(calls.length, 0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }),
);

serial("FINAL_PAY_STORE forces the JSON file even when a Redis pair is complete", () =>
  withEnv(async () => {
    const dir = await mkdtemp(join(tmpdir(), "final-pay-"));
    process.env.FINAL_PAY_STORE = join(dir, "pay-store.json");
    process.env.KV_REST_API_URL = SECRET_HOST;
    process.env.KV_REST_API_TOKEN = SECRET;
    const calls = installFetch(() => {
      throw new Error("redis should not be called");
    });
    try {
      await upsertRecord(row({ amount: "local-override" }));
      assert.equal((await getRecord("tok"))?.amount, "local-override");
      assert.equal(calls.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }),
);

serial("Redis read HTTP failure throws and does not fall back to the JSON file", () =>
  withEnv(async () => {
    process.env.KV_REST_API_URL = SECRET_HOST;
    process.env.KV_REST_API_TOKEN = SECRET;
    await withSentinel(async () => {
      installFetch(
        () =>
          new Response(JSON.stringify({ error: SECRET, url: SECRET_HOST }), {
            status: 503,
          }),
      );
      await assert.rejects(
        () => getRecord("sentinel"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.message, "Payment store read failed. HTTP 503");
          assertNoSecret(err.message);
          return true;
        },
      );
    });
  }),
);

serial("Redis read network failure throws a generic error", () =>
  withEnv(async () => {
    process.env.KV_REST_API_URL = SECRET_HOST;
    process.env.KV_REST_API_TOKEN = SECRET;
    await withSentinel(async () => {
      installFetch(() => {
        throw new Error(`connect failed ${SECRET_HOST} ${SECRET}`);
      });
      await assert.rejects(
        () => getRecord("sentinel"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.message, "Payment store read failed.");
          assertNoSecret(err.message);
          return true;
        },
      );
    });
  }),
);

serial("corrupt Redis JSON throws and is not written back as an empty store", () =>
  withEnv(async () => {
    process.env.KV_REST_API_URL = SECRET_HOST;
    process.env.KV_REST_API_TOKEN = SECRET;
    await withSentinel(async () => {
      const calls = installFetch(() => {
        return new Response(JSON.stringify({ result: "{not-json", leak: SECRET }), { status: 200 });
      });
      await assert.rejects(
        () => upsertRecord(row()),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.message, "Payment store read failed.");
          assertNoSecret(err.message);
          return true;
        },
      );
      assert.equal(
        calls.some((call) => call.method === "POST"),
        false,
      );
    });
  }),
);

serial("a missing Redis key is an empty store", () =>
  withEnv(async () => {
    process.env.KV_REST_API_URL = "https://kv.example.test";
    process.env.KV_REST_API_TOKEN = "kv-token";
    installFetch(() => kvBody(null));
    assert.equal(await getRecord("tok"), null);
  }),
);

serial("Redis write non-2xx throws and does not fall back to the JSON file", () =>
  withEnv(async () => {
    process.env.KV_REST_API_URL = SECRET_HOST;
    process.env.KV_REST_API_TOKEN = SECRET;
    await withSentinel(async () => {
      installFetch((call) => {
        if (call.method === "GET") return kvBody(null);
        return new Response(JSON.stringify({ error: SECRET, url: SECRET_HOST }), { status: 500 });
      });
      await assert.rejects(
        () => upsertRecord(row()),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.message, "Payment store write failed. HTTP 500");
          assertNoSecret(err.message);
          return true;
        },
      );
    });
  }),
);

serial("Redis write network failure throws a generic error", () =>
  withEnv(async () => {
    process.env.KV_REST_API_URL = SECRET_HOST;
    process.env.KV_REST_API_TOKEN = SECRET;
    installFetch((call) => {
      if (call.method === "GET") return kvBody(null);
      throw new Error(`write failed ${SECRET_HOST} ${SECRET}`);
    });
    await assert.rejects(
      () => upsertRecord(row()),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "Payment store write failed.");
        assertNoSecret(err.message);
        return true;
      },
    );
  }),
);

serial("a later upsert cannot clear paidTx that Redis has at write time", () =>
  withEnv(async () => {
    process.env.KV_REST_API_URL = "https://kv.example.test";
    process.env.KV_REST_API_TOKEN = "kv-token";
    const open = row();
    const calls = installFetch((call, index) => {
      if (call.method !== "GET") return new Response("{}", { status: 200 });
      if (index === 0) return kvBody({ records: { tok: open } });
      return kvBody({
        records: {
          tok: { ...open, paidTx: TX },
          other: row({ token: "other", paidTx: TX_OTHER }),
        },
      });
    });
    const saved = await upsertRecord(row({ amount: "9.00", memo: "changed", paidTx: null }));
    assert.equal(saved.paidTx, TX);
    assert.equal(saved.amount, "9.00");
    const posted = calls.find((call) => call.method === "POST");
    const stored = decodeSet(posted?.body);
    assert.equal(stored.records.tok?.paidTx, TX);
    assert.equal(stored.records.other?.paidTx, TX_OTHER);
  }),
);

serial("an unrelated update cannot clear cancelled that Redis has at write time", () =>
  withEnv(async () => {
    process.env.KV_REST_API_URL = "https://kv.example.test";
    process.env.KV_REST_API_TOKEN = "kv-token";
    const open = row();
    const calls = installFetch((call, index) => {
      if (call.method !== "GET") return new Response("{}", { status: 200 });
      if (index === 0) return kvBody({ records: { tok: open } });
      return kvBody({
        records: {
          tok: { ...open, cancelled: true, cancelledAt: "2026-02-02T00:00:00.000Z" },
          other: row({ token: "other", cancelled: true, cancelledAt: "2026-02-03T00:00:00.000Z" }),
        },
      });
    });
    const viewed = await markViewed("tok");
    assert.ok(viewed);
    assert.equal(viewed.cancelled, true);
    assert.equal(viewed.cancelledAt, "2026-02-02T00:00:00.000Z");
    assert.equal(viewed.views, 1);
    const stored = decodeSet(calls.find((call) => call.method === "POST")?.body);
    assert.equal(stored.records.tok?.cancelled, true);
    assert.equal(stored.records.tok?.views, 1);
    assert.equal(stored.records.other?.cancelled, true);
  }),
);

serial("unpaid becomes paid through Redis", () =>
  withEnv(async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "upstash-token";
    const open = row();
    const calls = installFetch((call) => {
      if (call.method === "GET") return kvBody({ records: { tok: open } });
      return new Response("{}", { status: 200 });
    });
    const paid = await markPaid("tok", { version: 1, tx: TX });
    assert.equal(paid?.paidTx, TX);
    assert.equal(paid?.cancelled, false);
    const stored = decodeSet(calls.find((call) => call.method === "POST")?.body);
    assert.equal(stored.records.tok?.paidTx, TX);
  }),
);

serial("open becomes cancelled through Redis", () =>
  withEnv(async () => {
    process.env.KV_REST_API_URL = "https://kv.example.test";
    process.env.KV_REST_API_TOKEN = "kv-token";
    const open = row();
    const calls = installFetch((call) => {
      if (call.method === "GET") return kvBody({ records: { tok: open } });
      return new Response("{}", { status: 200 });
    });
    const cancelled = await markCancelled("tok", { version: 1, payee: PAYEE });
    assert.equal(cancelled?.cancelled, true);
    assert.equal(cancelled?.paidTx, null);
    const stored = decodeSet(calls.find((call) => call.method === "POST")?.body);
    assert.equal(stored.records.tok?.cancelled, true);
    assert.equal(stored.records.tok?.paidTx, null);
  }),
);

serial("local JSON store works when Redis env is absent", () =>
  withEnv(async () => {
    const dir = await mkdtemp(join(tmpdir(), "final-pay-"));
    process.env.FINAL_PAY_STORE = join(dir, "pay-store.json");
    const calls = installFetch(() => {
      throw new Error("redis should not be called");
    });
    try {
      await upsertRecord(row());
      assert.equal((await getRecord("tok"))?.paidTx, null);
      const paid = await markPaid("tok", { version: 1, tx: TX });
      assert.equal(paid?.paidTx, TX);
      const again = await upsertRecord(row({ amount: "9.00", paidTx: null }));
      assert.equal(again.paidTx, TX);
      assert.equal(again.amount, "1.00");
      const stillPaid = await markCancelled("tok", { version: 1, payee: PAYEE });
      assert.equal(stillPaid?.paidTx, TX);
      assert.equal(stillPaid?.cancelled, false);

      await upsertRecord(row({ token: "open-me" }));
      const cancelled = await markCancelled("open-me", { version: 1, payee: PAYEE });
      assert.equal(cancelled?.cancelled, true);
      assert.equal((await getRecord("open-me"))?.cancelled, true);

      const requestId = `0x${"ab".repeat(16)}`;
      await upsertRecord(row({ token: "v2", id: requestId }));
      const v2 = await markPaid("v2", {
        version: 2,
        tx: TX_OTHER,
        requestId,
        blockTimestamp: 10,
        expiresAt: 20,
      });
      assert.equal(v2?.paidTx, TX_OTHER);
      assert.equal(calls.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }),
);
