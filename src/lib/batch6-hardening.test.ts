import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { getAddress } from "viem";
import { authenticateAuthorization, apiKeyPrefix, hashApiSecret, resetApiKeyRateLimits, type ApiKeyRecord, type ApiKeyRuntime } from "./apiKeys";
import {
  RATE_LIMIT_KEY_PREFIX,
  RATE_LIMIT_TTL_GRACE_SECONDS,
  createRedisRateLimiter,
  defaultDistributedRateLimiter,
  distributedAllow,
  identityFingerprint,
  rateLimitKey,
  type DistributedRateLimiter,
} from "./distributedRateLimit";
import { createFakeRedis } from "./fakeRedisRest";
import { PAY_STORE_KEY } from "./payStoreCas";
import { pinnedHttpsRequest, pinnedLookup } from "./pinnedHttps";
import { FixedWindowLimiter, LEGACY_RATE_RULES, legacyAllow } from "./publicRateLimit";
import { contentSecurityPolicy, securityHeaders } from "./securityHeaders";
import {
  assertSafeWebhookDestination,
  createWebhookEndpoint,
  defaultWebhookDeps,
  sendWebhookTest,
  signWebhookBody,
  type WebhookDeps,
} from "./webhooks";
import { WEBHOOK_HEADERS } from "./webhooksCatalog";

const MERCHANT = getAddress("0x00000000000000000000000000000000000000b6");
const KEY = randomBytes(32); // per-run test key; never a real key, never printed

/* ------------------------------------------------------------------ P2-03 */

describe("P2-03 DNS validation returns the exact set used for connect", () => {
  test("public IPv4 / IPv6 accepted and returned verbatim", async () => {
    assert.deepEqual(await assertSafeWebhookDestination("https://hooks.example.com/x", async () => ["93.184.216.34"]), ["93.184.216.34"]);
    assert.deepEqual(
      await assertSafeWebhookDestination("https://hooks.example.com/x", async () => ["2606:2800:220:1:248:1893:25c8:1946"]),
      ["2606:2800:220:1:248:1893:25c8:1946"],
    );
    assert.deepEqual(await assertSafeWebhookDestination("https://93.184.216.34/x"), ["93.184.216.34"]);
  });

  test("private IPv4, private/link-local IPv6, metadata, and mixed answers rejected", async () => {
    for (const answer of [["10.0.0.1"], ["169.254.169.254"], ["127.0.0.1"], ["fd00::1"], ["fe80::1"], ["::1"], ["::ffff:127.0.0.1"], ["93.184.216.34", "192.168.1.5"], ["2606:2800:220:1::1", "fc00::5"], ["not-an-ip"]]) {
      await assert.rejects(() => assertSafeWebhookDestination("https://hooks.example.com/x", async () => answer), JSON.stringify(answer));
    }
  });

  test("pinnedLookup never re-resolves: only pinned addresses, only the pinned host", async () => {
    const lookup = pinnedLookup("hooks.example.com", ["93.184.216.34", "2606:2800:220:1::1"]);
    const call = (host: string, opts: object) =>
      new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) =>
        lookup(host, opts, (err, address, family) => resolve({ err, address, family })),
      );
    assert.deepEqual((await call("hooks.example.com", { all: true })).address, [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ]);
    const v6 = await call("HOOKS.example.com", { family: 6 });
    assert.equal(v6.address, "2606:2800:220:1::1");
    assert.equal(v6.family, 6);
    assert.equal((await call("evil.example.com", {})).err?.code, "ENOTFOUND");
    assert.throws(() => pinnedLookup("hooks.example.com", []));
    assert.throws(() => pinnedLookup("hooks.example.com", ["hooks.example.com"]));
  });

  test("default transport refuses to send without validated addresses", async () => {
    await assert.rejects(() =>
      defaultWebhookDeps().fetch("https://hooks.example.com/x", { method: "POST", headers: {}, body: "{}" }),
    );
  });

  test("delivery connects with the validated answer; a changed answer is rejected before any HTTP", async () => {
    const saved = { ...process.env };
    for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) delete process.env[k];
    const dir = await mkdtemp(join(tmpdir(), "final-b6-"));
    process.env.FINAL_PAY_STORE = join(dir, "pay-store.json");
    await writeFile(process.env.FINAL_PAY_STORE, JSON.stringify({ records: {} }));
    try {
      let answer = ["93.184.216.34"];
      let resolves = 0;
      const sent: { pinned: readonly string[] | undefined; headers: Record<string, string>; body: string }[] = [];
      let seq = 0;
      const deps: WebhookDeps = {
        nowSeconds: () => 1_700_000_000 + seq,
        caller: MERCHANT,
        randomId: (p) => `${p}_${(++seq).toString(16).padStart(8, "0")}`,
        createSecret: () => `whsec_b6_${randomBytes(8).toString("hex")}`,
        encryptionKey: () => KEY,
        resolveHost: async () => {
          resolves += 1;
          return answer;
        },
        fetch: async (_url, init) => {
          sent.push({ pinned: init.pinnedAddresses, headers: init.headers, body: init.body });
          return new Response(null, { status: 200 });
        },
      };
      const created = await createWebhookEndpoint({ merchant: MERCHANT, url: "https://hooks.example.com/final", events: ["webhook.test"] }, deps);
      assert.equal(created.status, 200);
      const id = (created.body as { id: string }).id;

      await sendWebhookTest(id, MERCHANT, deps);
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].pinned, ["93.184.216.34"]);
      // HMAC still computed with the decrypted (AES-GCM at rest) secret.
      const secret = (created.body as { secret: string }).secret;
      const ts = Number(sent[0].headers[WEBHOOK_HEADERS.timestamp]);
      assert.equal(sent[0].headers[WEBHOOK_HEADERS.signature], signWebhookBody(secret, ts, sent[0].body));

      // DNS rebinding: the next answer is private. No HTTP request is made.
      answer = ["10.0.0.7"];
      const before = resolves;
      await sendWebhookTest(id, MERCHANT, deps);
      assert.ok(resolves > before);
      assert.equal(sent.length, 1);

      // Mixed public/private answer is rejected as a whole.
      answer = ["93.184.216.34", "172.16.0.1"];
      await sendWebhookTest(id, MERCHANT, deps);
      assert.equal(sent.length, 1);
    } finally {
      process.env = saved;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/* Real TLS on loopback: the hostname "hooks.final-b6.test" does not exist in DNS, so a
 * successful request proves the socket used the pinned address, while TLS still
 * verified the certificate for the original hostname. */
function makeCert(dir: string, cn: string): { key: string; cert: string } | null {
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${cn}`, "-addext", `subjectAltName=DNS:${cn}`, "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")],
      { stdio: "ignore" },
    );
    return { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: readFileSync(join(dir, "c.pem"), "utf8") };
  } catch {
    return null;
  }
}

describe("P2-03 pinned HTTPS transport (loopback TLS)", () => {
  const HOST = "hooks.final-b6.test";
  const dir = mkdtempSync(join(tmpdir(), "final-b6-tls-"));
  const pem = makeCert(dir, HOST);
  let server: Server;
  let port = 0;
  const seen: { sni: string | undefined; path: string | undefined; body: string; sig: string | undefined }[] = [];

  before(async () => {
    if (!pem) return;
    server = createServer({ key: pem.key, cert: pem.cert }, (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ sni: (req.socket as unknown as { servername?: string }).servername, path: req.url, body, sig: req.headers["x-sig"] as string | undefined });
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "https://127.0.0.1/internal" });
          res.end();
        } else if (req.url === "/hang") {
          // never respond
        } else {
          res.writeHead(204);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(() => {
    server?.closeAllConnections?.();
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const base = { method: "POST" as const, headers: { "content-type": "application/json", "x-sig": "abc123" }, body: '{"ok":true}', addresses: ["127.0.0.1"], timeoutMs: 2000 };

  test("connects to the pinned IP with SNI + cert check for the original hostname", { skip: !pem }, async () => {
    const res = await pinnedHttpsRequest({ ...base, url: `https://${HOST}:${port}/hook`, ca: pem!.cert });
    assert.equal(res.status, 204);
    const last = seen.at(-1)!;
    assert.equal(last.sni, HOST);
    assert.equal(last.body, '{"ok":true}');
    assert.equal(last.sig, "abc123");
  });

  test("certificate hostname mismatch fails closed", { skip: !pem }, async () => {
    await assert.rejects(() => pinnedHttpsRequest({ ...base, url: `https://other.final-b6.test:${port}/hook`, ca: pem!.cert }), /altname|hostname|Hostname/i);
  });

  test("untrusted certificate fails closed (verification is on)", { skip: !pem }, async () => {
    await assert.rejects(() => pinnedHttpsRequest({ ...base, url: `https://${HOST}:${port}/hook` }));
  });

  test("redirects are not followed", { skip: !pem }, async () => {
    const count = seen.length;
    const res = await pinnedHttpsRequest({ ...base, url: `https://${HOST}:${port}/redirect`, ca: pem!.cert });
    assert.equal(res.status, 302);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(seen.length, count + 1);
  });

  test("bounded timeout", { skip: !pem }, async () => {
    const started = Date.now();
    await assert.rejects(() => pinnedHttpsRequest({ ...base, url: `https://${HOST}:${port}/hang`, ca: pem!.cert, timeoutMs: 200 }), /timed out/);
    assert.ok(Date.now() - started < 1500);
  });

  test("IP literal not in the validated set and non-https are refused", async () => {
    await assert.rejects(() => pinnedHttpsRequest({ ...base, url: "https://10.0.0.1/x", addresses: ["93.184.216.34"] }));
    await assert.rejects(() => pinnedHttpsRequest({ ...base, url: "http://hooks.example.com/x" }));
  });
});

/* ------------------------------------------------------------------ P3-05 */

describe("P3-05 headers unchanged", () => {
  test("framing, sniffing, referrer, permissions, HSTS preserved", () => {
    const csp = contentSecurityPolicy(false);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    const map = new Map(securityHeaders(false).map((h) => [h.key, h.value]));
    assert.equal(map.get("X-Frame-Options"), "DENY");
    assert.equal(map.get("X-Content-Type-Options"), "nosniff");
    assert.ok(map.get("Strict-Transport-Security"));
    assert.ok(map.get("Permissions-Policy"));
  });
});

/* ------------------------------------------------------------- rate limiting */

function fakeLimiter(nowRef: { t: number }) {
  const redis = createFakeRedis();
  const make = () =>
    createRedisRateLimiter({ url: "https://redis.fake", token: "test-token", fetch: (i, init) => redis.fetch(i, init), nowSeconds: () => nowRef.t });
  return { redis, make };
}

describe("Distributed rate limiting", () => {
  test("keys: prefixed, hashed identity, window-scoped, never the pay-store key", () => {
    const key = rateLimitKey("api.preauth", "ip:203.0.113.9", 60, 1_700_000_030);
    assert.ok(key.startsWith(RATE_LIMIT_KEY_PREFIX));
    assert.ok(!key.includes("203.0.113.9"));
    assert.ok(key.includes(identityFingerprint("ip:203.0.113.9")));
    assert.ok(key.endsWith(`:${Math.floor(1_700_000_030 / 60)}`));
    assert.notEqual(key, PAY_STORE_KEY);
    assert.throws(() => rateLimitKey("bad class!", "x", 60, 0));
  });

  test("concurrent hits from two instances share one atomic counter", async () => {
    const now = { t: 1_700_000_000 };
    const { redis, make } = fakeLimiter(now);
    const a = make();
    const b = make();
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).hit("receipt.proof", "ip:198.51.100.1", 10, 60)));
    assert.equal(results.filter((r) => r === "allow").length, 10);
    assert.equal(results.filter((r) => r === "deny").length, 30);
    assert.equal(redis.rateLimitCalls, 40);
    // Only final-ratelimit keys were written.
    for (const key of redis.values.keys()) assert.ok(key.startsWith(RATE_LIMIT_KEY_PREFIX));
    assert.ok(!redis.values.has(PAY_STORE_KEY));
  });

  test("bounded TTL on every key; new window gets a fresh counter", async () => {
    const now = { t: 1_700_000_000 };
    const { redis, make } = fakeLimiter(now);
    const lim = make();
    for (let i = 0; i < 3; i++) await lim.hit("api.key", "key:k1", 2, 60);
    assert.equal(await lim.hit("api.key", "key:k1", 2, 60), "deny");
    now.t += 60;
    assert.equal(await lim.hit("api.key", "key:k1", 2, 60), "allow");
    assert.equal(redis.values.size, 2);
    for (const ttl of redis.ttls.values()) assert.equal(ttl, 60 + RATE_LIMIT_TTL_GRACE_SECONDS);
  });

  test("Redis failure is 'unavailable' and falls back to the local decision", async () => {
    const down = createRedisRateLimiter({ url: "https://redis.fake", token: "t", fetch: async () => new Response("err", { status: 500 }) });
    assert.equal(await down.hit("api.key", "x", 1, 60), "unavailable");
    const throws = createRedisRateLimiter({ url: "https://redis.fake", token: "t", fetch: async () => { throw new Error("net"); } });
    assert.equal(await distributedAllow(throws, "api.key", "x", 1, 60), true);
    assert.equal(await distributedAllow(null, "api.key", "x", 1, 60), true);
  });

  test("legacyAllow: local deny short-circuits; shared deny is enforced", async () => {
    let hits = 0;
    const deny: DistributedRateLimiter = { kind: "redis", hit: async () => { hits += 1; return "deny"; } };
    const local = new FixedWindowLimiter(LEGACY_RATE_RULES, () => 1_700_000_000);
    assert.equal(await legacyAllow("receipt.proof", "ip:1.1.1.1", { local, distributed: deny }), false);
    assert.equal(hits, 1);
    const tight = new FixedWindowLimiter({ ...LEGACY_RATE_RULES, "receipt.proof": { perKey: 1, global: 10, windowSeconds: 60 } }, () => 1_700_000_000);
    tight.allow("receipt.proof", "ip:1.1.1.1"); // exhaust the local per-key quota
    assert.equal(await legacyAllow("receipt.proof", "ip:1.1.1.1", { local: tight, distributed: deny }), false);
    assert.equal(hits, 1);
    const allow: DistributedRateLimiter = { kind: "redis", hit: async () => "allow" };
    assert.equal(await legacyAllow("receipt.proof", "ip:2.2.2.2", { local, distributed: allow }), true);
  });

  test("file backend => process-local only (no Redis limiter)", () => {
    const saved = { ...process.env };
    try {
      process.env.FINAL_PAY_STORE = join(tmpdir(), "nope.json");
      assert.equal(defaultDistributedRateLimiter(), null);
    } finally {
      process.env = saved;
    }
  });

  test("API auth: shared pre-auth limit enforced before any key lookup; no raw key material in Redis", async () => {
    resetApiKeyRateLimits();
    const pepper = "test-pepper-not-real";
    const secret = `final_live_${randomBytes(24).toString("base64url")}`;
    const row: ApiKeyRecord = {
      id: "key_b6",
      merchant: MERCHANT,
      name: "b6",
      prefix: apiKeyPrefix(secret),
      hash: hashApiSecret(secret, pepper),
      scopes: ["webhooks:read"],
      enabled: true,
      revoked: false,
      createdAt: new Date(0).toISOString(),
      lastUsedAt: null,
      expiresAt: null,
    };
    const now = { t: 1_700_000_000 };
    const { redis, make } = fakeLimiter(now);
    let listed = 0;
    const runtime = (limiter: DistributedRateLimiter): ApiKeyRuntime => ({
      nowSeconds: () => now.t,
      pepper,
      rateLimitPerMinute: 3,
      distributedRateLimit: limiter,
      listKeys: async () => {
        listed += 1;
        return [row];
      },
      upsertKey: async () => {},
      createKey: async () => {},
      touchLastUsed: async () => {},
    });
    const ok = await authenticateAuthorization(`Bearer ${secret}`, "webhooks:read", runtime(make()));
    assert.equal(ok.ok, true);
    // Post-auth per-key shared limit (3/min) across two "instances".
    const r2 = await authenticateAuthorization(`Bearer ${secret}`, "webhooks:read", runtime(make()));
    const r3 = await authenticateAuthorization(`Bearer ${secret}`, "webhooks:read", runtime(make()));
    resetApiKeyRateLimits(); // simulate a different instance: local counters empty
    const r4 = await authenticateAuthorization(`Bearer ${secret}`, "webhooks:read", runtime(make()));
    assert.equal(r2.ok && r3.ok, true);
    assert.equal(r4.ok, false);
    assert.equal((r4 as { status: number }).status, 429);
    for (const key of redis.values.keys()) {
      assert.ok(key.startsWith(RATE_LIMIT_KEY_PREFIX));
      assert.ok(!key.includes(secret) && !key.includes(row.prefix) && !key.includes(row.id) && !key.includes(row.hash));
    }
    // Shared pre-auth deny stops work before listKeys.
    listed = 0;
    const deny: DistributedRateLimiter = { kind: "redis", hit: async (cls) => (cls === "api.preauth" ? "deny" : "allow") };
    const blocked = await authenticateAuthorization(`Bearer ${secret}`, "webhooks:read", runtime(deny));
    assert.equal((blocked as { status: number }).status, 429);
    assert.equal(listed, 0);
    resetApiKeyRateLimits();
  });
});
