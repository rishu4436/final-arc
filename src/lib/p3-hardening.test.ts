import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { getAddress } from "viem";
import { Final } from "../../sdk/src/client";
import { FinalConfigurationError } from "../../sdk/src/errors";
import { isLoopbackHost, pathSegment } from "../../sdk/src/http";
import { ESCROW_VIEW_STALE_MS, escrowFreshness, submittedHashNote } from "./escrowFreshness";
import { contentSecurityPolicy, NO_REFERRER_SOURCES, securityHeaders } from "./securityHeaders";
import { parseStrictBoolean, readBooleanEnv } from "./strictBool";
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  isEncryptedWebhookSecret,
  parseWebhookEncryptionKey,
} from "./webhookSecretCrypto";
import {
  createWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookDeliveries,
  sendWebhookTest,
  updateWebhookEndpoint,
  verifyWebhookSignature,
  type WebhookDeps,
} from "./webhooks";

// Random per-run test keys. Never a real key; never printed.
const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
const API_KEY = "final_live_example_key_not_real";
const MERCHANT = getAddress("0x00000000000000000000000000000000000000a1");

/* ------------------------------------------------------------------ P3-01 */

describe("P3-01 SDK baseUrl transport", () => {
  test("https accepted and trailing slash normalized", () => {
    assert.doesNotThrow(() => new Final({ apiKey: API_KEY, baseUrl: "https://staging.example.com/" }));
  });

  test("plain http to non-loopback hosts is rejected", () => {
    for (const baseUrl of [
      "http://final-arc-eight.vercel.app",
      "http://example.com",
      "http://10.0.0.5",
      "http://192.168.1.10:3000",
      "http://localhost.evil.com",
      "http://127.0.0.1.nip.io",
      "http://[::2]",
    ]) {
      assert.throws(() => new Final({ apiKey: API_KEY, baseUrl }), FinalConfigurationError, baseUrl);
    }
  });

  test("http allowed only for exact loopback dev hosts", () => {
    for (const baseUrl of ["http://localhost:3000", "http://127.0.0.1:3000/", "http://[::1]:3000", "http://LOCALHOST"]) {
      assert.doesNotThrow(() => new Final({ apiKey: API_KEY, baseUrl }), baseUrl);
    }
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("[::1]"), true);
    assert.equal(isLoopbackHost("127.0.0.2"), false);
  });

  test("malformed, credential-bearing, query, and non-http(s) URLs are rejected", () => {
    for (const baseUrl of [
      "not a url",
      "",
      "ftp://example.com",
      "javascript:alert(1)",
      "https://user:pass@example.com",
      "https://example.com?apiKey=x",
      "https://example.com/#frag",
    ]) {
      assert.throws(() => new Final({ apiKey: API_KEY, baseUrl }), FinalConfigurationError, baseUrl);
    }
  });
});

/* ------------------------------------------------------------------ P3-02 */

describe("P3-02 SDK path-segment encoding", () => {
  const originalFetch = globalThis.fetch;
  let urls: string[] = [];
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  function install() {
    urls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      // The API key must travel only in the Authorization header.
      assert.ok(!url.includes(API_KEY));
      assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${API_KEY}`);
      return new Response(
        JSON.stringify({ escrow: {}, policy: {}, intent: {}, requestId: "x", status: "OPEN" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
  }

  test("canonical ids are unchanged", async () => {
    install();
    const final = new Final({ apiKey: API_KEY, baseUrl: "https://api.example.com" });
    const id = "0x" + "ab".repeat(32);
    await final.escrows.get(id);
    assert.equal(urls[0], `https://api.example.com/api/v1/escrows/${id}`);
  });

  test("hostile ids cannot inject segments, queries, or fragments", async () => {
    install();
    const final = new Final({ apiKey: API_KEY, baseUrl: "https://api.example.com" });
    const hostile = ["a/b", "../../api-keys", "x?scope=all", "x#frag", "a\\b", "%2e%2e", "id with space"];
    for (const id of hostile) {
      await final.escrows.proof(id);
      await final.policies.get(id);
      await final.agent.paymentIntents.get(id);
      await final.paymentRequests.get(id);
      await final.verify.transaction(id);
    }
    for (const url of urls) {
      const parsed = new URL(url);
      assert.equal(parsed.search, "", url);
      assert.equal(parsed.hash, "", url);
      assert.ok(parsed.pathname.startsWith("/api/v1/"), url);
      assert.ok(!parsed.pathname.includes("/../") && !parsed.pathname.endsWith("/.."), url);
    }
    const proofUrl = urls[0];
    assert.equal(new URL(proofUrl).pathname, "/api/v1/escrows/a%2Fb/proof");
    // A literal "%2e%2e" input is encoded once (to %252e%252e), never decoded into traversal.
    assert.ok(urls.some((u) => u.includes("%252e%252e")));
  });

  test("dot segments and empty ids are rejected before any request", async () => {
    install();
    const final = new Final({ apiKey: API_KEY, baseUrl: "https://api.example.com" });
    for (const id of [".", "..", ""]) {
      await assert.rejects(() => final.escrows.get(id), FinalConfigurationError);
      await assert.rejects(() => final.policies.delete(id), FinalConfigurationError);
    }
    assert.equal(urls.length, 0);
    assert.throws(() => pathSegment(undefined), FinalConfigurationError);
    assert.equal(pathSegment("abc_123"), "abc_123");
  });
});

/* ------------------------------------------------------------------ P3-03 */

describe("P3-03 strict boolean parsing", () => {
  test("Boolean('false') pitfall is not reproduced", () => {
    assert.equal(parseStrictBoolean("false"), false);
    assert.equal(parseStrictBoolean(" FALSE "), false);
    assert.equal(parseStrictBoolean("0"), false);
    assert.equal(parseStrictBoolean(false), false);
    assert.equal(parseStrictBoolean("true"), true);
    assert.equal(parseStrictBoolean("1"), true);
    assert.equal(parseStrictBoolean(true), true);
    for (const bad of ["yes", "no", "on", "", "2", 1, 0, null, undefined, {}, []]) {
      assert.equal(parseStrictBoolean(bad), null, String(bad));
    }
  });

  test("env flags: unset -> fallback, malformed -> fail closed", () => {
    assert.equal(readBooleanEnv("X", false, false, {}), false);
    assert.equal(readBooleanEnv("X", true, false, { X: "  " }), true);
    assert.equal(readBooleanEnv("X", false, false, { X: "false" }), false);
    assert.equal(readBooleanEnv("X", false, false, { X: "true" }), true);
    assert.equal(readBooleanEnv("X", false, false, { X: "enabled" }), false);
  });
});

/* ------------------------------------------------------------- webhooks */

const ENV_KEYS = [
  "FINAL_PAY_STORE",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "FINAL_WEBHOOK_ENCRYPTION_KEY",
] as const;

type Call = { url: string; headers: Record<string, string>; body: string };

function deps(opts: { key: Buffer | null; calls?: Call[]; secrets?: string[] }): WebhookDeps {
  let seq = 0;
  return {
    nowSeconds: () => 1_700_000_000,
    caller: MERCHANT,
    randomId: (p) => `${p}_${(++seq).toString(16).padStart(8, "0")}_${randomBytes(2).toString("hex")}`,
    createSecret: () => {
      const s = `whsec_p3_${randomBytes(8).toString("hex")}`;
      opts.secrets?.push(s);
      return s;
    },
    resolveHost: async () => ["93.184.216.34"],
    encryptionKey: () => opts.key,
    fetch: async (url, init) => {
      opts.calls?.push({ url, headers: init.headers, body: init.body });
      return new Response(null, { status: 200 });
    },
  };
}

async function withStore(fn: (path: string) => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const dir = await mkdtemp(join(tmpdir(), "final-p3-"));
  const path = join(dir, "pay-store.json");
  process.env.FINAL_PAY_STORE = path;
  await writeFile(path, JSON.stringify({ records: {} }));
  try {
    await fn(path);
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

const URL_OK = "https://hooks.example.com/final";

describe("P3-03 webhook enabled flag", () => {
  test('enabled: "false" disables (not truthy) and junk is rejected', async () => {
    await withStore(async () => {
      const d = deps({ key: KEY_A });
      const created = await createWebhookEndpoint({ merchant: MERCHANT, url: URL_OK, events: ["webhook.test"], enabled: "false" }, d);
      assert.equal(created.status, 200);
      const id = (created.body as { id: string; enabled: boolean }).id;
      assert.equal((created.body as { enabled: boolean }).enabled, false);
      const junk = await createWebhookEndpoint({ merchant: MERCHANT, url: URL_OK, events: ["webhook.test"], enabled: "yes" }, d);
      assert.equal(junk.status, 400);
      const on = await updateWebhookEndpoint(id, { merchant: MERCHANT, enabled: true }, d);
      assert.equal((on.body as { enabled: boolean }).enabled, true);
      const off = await updateWebhookEndpoint(id, { merchant: MERCHANT, enabled: "false" }, d);
      assert.equal((off.body as { enabled: boolean }).enabled, false);
      const bad = await updateWebhookEndpoint(id, { merchant: MERCHANT, enabled: 1 }, d);
      assert.equal(bad.status, 400);
    });
  });
});

/* ------------------------------------------------------------------ P3-04 */

describe("P3-04 escrow display freshness", () => {
  test("fresh, aged, invalidated, and unloaded states", () => {
    const t = 1_700_000_000_000;
    assert.equal(escrowFreshness(t, t + 1000, false).stale, false);
    assert.equal(escrowFreshness(t, t + ESCROW_VIEW_STALE_MS + 1, false).stale, true);
    assert.equal(escrowFreshness(t, t + 1000, true).stale, true);
    assert.match(escrowFreshness(t, t + 1000, true).line, /may be behind/);
    assert.equal(escrowFreshness(null, t, false).stale, true);
  });
  test("submitted is never described as confirmed", () => {
    const note = submittedHashNote("Fund");
    assert.match(note, /submitted/);
    assert.match(note, /Not confirmed/);
  });
});

/* ------------------------------------------------------------------ P3-05 */

describe("P3-05 security headers", () => {
  test("production policy forbids framing and plugins", () => {
    const csp = contentSecurityPolicy(false);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'self'/);
    assert.match(csp, /form-action 'self'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    const map = new Map(securityHeaders(false).map((h) => [h.key, h.value]));
    assert.equal(map.get("X-Frame-Options"), "DENY");
    assert.equal(map.get("X-Content-Type-Options"), "nosniff");
    assert.equal(map.get("Referrer-Policy"), "strict-origin-when-cross-origin");
    assert.ok(map.get("Permissions-Policy")?.includes("camera=()"));
    assert.ok(map.get("Strict-Transport-Security")?.startsWith("max-age="));
    assert.deepEqual([...NO_REFERRER_SOURCES], ["/p/:path*", "/r/:path*"]);
  });
  test("next.config wires the headers", async () => {
    const config = (await import("../../next.config")).default;
    const rules = await config.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    assert.ok(all?.headers.some((h) => h.key === "Content-Security-Policy"));
    assert.ok(rules.some((r) => r.source === "/p/:path*" && r.headers.some((h) => h.value === "no-referrer")));
  });
});

/* ------------------------------------------------------------------ P3-06 */

describe("P3-06 webhook secret encryption", () => {
  test("key parsing accepts 32-byte hex/base64 only", () => {
    assert.equal(parseWebhookEncryptionKey(KEY_A.toString("hex"))?.length, 32);
    assert.equal(parseWebhookEncryptionKey(KEY_A.toString("base64"))?.length, 32);
    assert.equal(parseWebhookEncryptionKey(KEY_A.toString("base64url"))?.length, 32);
    assert.equal(parseWebhookEncryptionKey(""), null);
    assert.equal(parseWebhookEncryptionKey(undefined), null);
    assert.equal(parseWebhookEncryptionKey("short"), null);
    assert.equal(parseWebhookEncryptionKey(randomBytes(16).toString("hex")), null);
  });

  test("AES-GCM round trip, binding, and tamper detection", () => {
    const b = { endpointId: "wh_1", merchant: MERCHANT };
    const ct = encryptWebhookSecret("whsec_abc", b, KEY_A);
    assert.ok(isEncryptedWebhookSecret(ct));
    assert.ok(!ct.includes("whsec_abc"));
    assert.equal(decryptWebhookSecret(ct, b, KEY_A), "whsec_abc");
    assert.notEqual(encryptWebhookSecret("whsec_abc", b, KEY_A), ct, "random IV");
    assert.throws(() => decryptWebhookSecret(ct, b, KEY_B));
    assert.throws(() => decryptWebhookSecret(ct, { ...b, endpointId: "wh_2" }, KEY_A));
    assert.throws(() => decryptWebhookSecret(ct, b, null));
    const tampered = ct.slice(0, -2) + (ct.endsWith("A") ? "BB" : "AA");
    assert.throws(() => decryptWebhookSecret(tampered, b, KEY_A));
    assert.equal(decryptWebhookSecret("whsec_legacy", b, null), "whsec_legacy", "legacy plaintext passthrough");
    assert.throws(() => encryptWebhookSecret("whsec_abc", b, null));
  });

  test("create stores only ciphertext; secret returned once; delivery signs with plaintext", async () => {
    await withStore(async (path) => {
      const calls: Call[] = [];
      const secrets: string[] = [];
      const d = deps({ key: KEY_A, calls, secrets });
      const created = await createWebhookEndpoint({ merchant: MERCHANT, url: URL_OK, events: ["webhook.test"] }, d);
      assert.equal(created.status, 200);
      const body = created.body as { id: string; secret: string };
      assert.equal(body.secret, secrets[0]);
      const raw = await readFile(path, "utf8");
      assert.ok(!raw.includes(secrets[0]), "plaintext secret must not be stored");
      assert.ok(!raw.includes(KEY_A.toString("hex")) && !raw.includes(KEY_A.toString("base64")));
      const stored = JSON.parse(raw).webhooks.endpoints[body.id].secret as string;
      assert.ok(isEncryptedWebhookSecret(stored));
      const got = await getWebhookEndpoint(body.id, MERCHANT, d);
      assert.equal("secret" in (got.body as object), false);
      await sendWebhookTest(body.id, MERCHANT, d);
      assert.equal(calls.length, 1);
      assert.equal(
        verifyWebhookSignature({
          secret: secrets[0],
          timestamp: calls[0].headers["X-Final-Webhook-Timestamp"],
          rawBody: calls[0].body,
          signature: calls[0].headers["X-Final-Webhook-Signature"],
          nowSeconds: 1_700_000_000,
        }),
        true,
      );
    });
  });

  test("missing key fails closed for new and rotated secrets; nothing plaintext is written", async () => {
    await withStore(async (path) => {
      const secrets: string[] = [];
      const none = deps({ key: null, secrets });
      const res = await createWebhookEndpoint({ merchant: MERCHANT, url: URL_OK, events: ["webhook.test"] }, none);
      assert.equal(res.status, 503);
      assert.equal((res.body as { error: { code: string } }).error.code, "webhook_encryption_unavailable");
      assert.ok(!JSON.stringify(res.body).includes("whsec_"));
      const raw = await readFile(path, "utf8");
      assert.ok(!raw.includes(secrets[0]));

      const withKey = deps({ key: KEY_A });
      const created = await createWebhookEndpoint({ merchant: MERCHANT, url: URL_OK, events: ["webhook.test"] }, withKey);
      const id = (created.body as { id: string }).id;
      const before = JSON.parse(await readFile(path, "utf8")).webhooks.endpoints[id].secret;
      const rotate = await updateWebhookEndpoint(id, { merchant: MERCHANT, rotateSecret: true }, none);
      assert.equal(rotate.status, 503);
      const after = JSON.parse(await readFile(path, "utf8")).webhooks.endpoints[id].secret;
      assert.equal(after, before, "old secret preserved on failed rotation");
    });
  });

  test("legacy plaintext rows still deliver and migrate on update with the same secret", async () => {
    await withStore(async (path) => {
      const legacySecret = "whsec_legacy_plaintext_example";
      const now = new Date(1_700_000_000_000).toISOString();
      await writeFile(
        path,
        JSON.stringify({
          records: {},
          webhooks: {
            endpoints: {
              wh_legacy: {
                id: "wh_legacy",
                merchant: MERCHANT,
                url: URL_OK,
                enabled: true,
                events: ["webhook.test"],
                secret: legacySecret,
                createdAt: now,
                updatedAt: now,
              },
            },
            deliveries: {},
          },
        }),
      );
      const calls: Call[] = [];
      // Legacy delivery works even with no key configured.
      await sendWebhookTest("wh_legacy", MERCHANT, deps({ key: null, calls }));
      assert.equal(calls.length, 1);
      assert.equal(
        verifyWebhookSignature({
          secret: legacySecret,
          timestamp: calls[0].headers["X-Final-Webhook-Timestamp"],
          rawBody: calls[0].body,
          signature: calls[0].headers["X-Final-Webhook-Signature"],
          nowSeconds: 1_700_000_000,
        }),
        true,
      );
      // Any update with a key re-encrypts the same secret value.
      const d = deps({ key: KEY_A, calls });
      const upd = await updateWebhookEndpoint("wh_legacy", { merchant: MERCHANT, events: ["webhook.test"] }, d);
      assert.equal(upd.status, 200);
      assert.equal("secret" in (upd.body as object), false);
      const raw = await readFile(path, "utf8");
      assert.ok(!raw.includes(legacySecret));
      await sendWebhookTest("wh_legacy", MERCHANT, d);
      const last = calls[calls.length - 1];
      assert.equal(
        verifyWebhookSignature({
          secret: legacySecret,
          timestamp: last.headers["X-Final-Webhook-Timestamp"],
          rawBody: last.body,
          signature: last.headers["X-Final-Webhook-Signature"],
          nowSeconds: 1_700_000_000,
        }),
        true,
      );
    });
  });

  test("encrypted secret with missing or wrong key: no HTTP, retryable failure, no leak", async () => {
    await withStore(async () => {
      const created = await createWebhookEndpoint(
        { merchant: MERCHANT, url: URL_OK, events: ["webhook.test"] },
        deps({ key: KEY_A }),
      );
      const id = (created.body as { id: string }).id;
      for (const key of [null, KEY_B]) {
        const calls: Call[] = [];
        const d = deps({ key, calls });
        const res = await sendWebhookTest(id, MERCHANT, d);
        assert.equal(calls.length, 0, "no HTTP without a usable secret");
        const delivery = (res.body as { delivery: { status: string; error: string | null } }).delivery;
        assert.equal(delivery.status, "retrying");
        assert.equal(delivery.error, "webhook_secret_unavailable");
      }
      const listed = await listWebhookDeliveries(MERCHANT, deps({ key: KEY_A }));
      assert.ok(!JSON.stringify(listed.body).includes(KEY_A.toString("hex")));
    });
  });
});
