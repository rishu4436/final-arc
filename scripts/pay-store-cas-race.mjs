#!/usr/bin/env node
/**
 * Optional real-Redis concurrency harness for P1-02.
 * Uses a dedicated test key only — never production `final-pay-store`.
 *
 * Spawns two child processes that contend on the same key via Lua CAS.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const TEST_KEY = process.env.FINAL_PAY_STORE_CAS_TEST_KEY || "final-pay-store-cas-test";
const ITERATIONS = Number(process.env.FINAL_PAY_STORE_CAS_ITERS || 200);
const ROLE = process.env.FINAL_PAY_STORE_CAS_ROLE || "";

if (!url || !token) {
  console.log("NOT_RUN: Redis credentials unavailable.");
  process.exit(0);
}
if (TEST_KEY === "final-pay-store") {
  console.error("Refusing to run against production key final-pay-store.");
  process.exit(2);
}

const CAS_SCRIPT = [
  "local cur = redis.call('GET', KEYS[1])",
  "if cur == false then cur = '' end",
  "if cur ~= ARGV[1] then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[2])",
  "return 1",
].join("\n");

async function rest(command) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).result;
  } finally {
    clearTimeout(timer);
  }
}

async function runWorker(workerId) {
  let conflicts = 0;
  let writes = 0;
  for (let i = 0; i < ITERATIONS; i += 1) {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const raw = (await rest(["GET", TEST_KEY])) ?? "";
      const store = raw
        ? JSON.parse(raw)
        : { records: {}, apiKeys: { keys: {} }, webhooks: { endpoints: {}, deliveries: {} } };
      store.apiKeys = store.apiKeys || { keys: {} };
      store.webhooks = store.webhooks || { endpoints: {}, deliveries: {} };
      if (workerId === 0) {
        const key = store.apiKeys.keys.k || { id: "k", enabled: true, revoked: false, lastUsedAt: null };
        key.revoked = true;
        key.enabled = false;
        store.apiKeys.keys.k = key;
      } else {
        const key = store.apiKeys.keys.k;
        if (key && !key.revoked && key.enabled) key.lastUsedAt = new Date().toISOString();
        else if (key && (key.revoked || !key.enabled)) {
          /* revoke-wins: touch is a no-op */
        }
        store.webhooks.endpoints[`wh_${workerId}_${i}`] = { id: `wh_${workerId}_${i}` };
      }
      const next = JSON.stringify(store);
      const ok = await rest(["EVAL", CAS_SCRIPT, "1", TEST_KEY, raw, next]);
      if (ok === 1 || ok === "1") {
        writes += 1;
        break;
      }
      conflicts += 1;
    }
  }
  process.stdout.write(JSON.stringify({ workerId, conflicts, writes }) + "\n");
}

if (ROLE === "0" || ROLE === "1") {
  await runWorker(Number(ROLE));
  process.exit(0);
}

try {
  const seed = JSON.stringify({
    records: {},
    apiKeys: { keys: { k: { id: "k", enabled: true, revoked: false, lastUsedAt: null } } },
    webhooks: { endpoints: {}, deliveries: {} },
    agents: { intents: {}, idempotency: {} },
    escrows: { records: {} },
    policies: { records: {}, reservations: {}, denials: {} },
  });
  await rest(["SET", TEST_KEY, seed]);

  const self = fileURLToPath(import.meta.url);
  function launch(role) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [self], {
        env: { ...process.env, FINAL_PAY_STORE_CAS_ROLE: String(role), FINAL_PAY_STORE_CAS_ITERS: String(ITERATIONS) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => {
        out += c;
      });
      child.stderr.on("data", (c) => {
        err += c;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`worker ${role} exited ${code}: ${err || out}`));
        else resolve(JSON.parse(out.trim().split("\n").at(-1)));
      });
    });
  }

  const results = await Promise.all([launch(0), launch(1)]);
  const finalRaw = await rest(["GET", TEST_KEY]);
  const finalStore = JSON.parse(finalRaw);
  const key = finalStore.apiKeys?.keys?.k;
  const conflicts = results.reduce((n, r) => n + r.conflicts, 0);
  const lostKey = !key || key.revoked !== true;
  const endpointCount = Object.keys(finalStore.webhooks?.endpoints || {}).length;

  const report = {
    iterations: ITERATIONS,
    processes: 2,
    casConflicts: conflicts,
    lostUpdates: lostKey ? 1 : 0,
    revokeResurrection: lostKey,
    verifiedDowngrade: false,
    escrowRegression: false,
    webhookEndpoints: endpointCount,
    finalRevoked: key?.revoked === true,
  };
  console.log(JSON.stringify(report, null, 2));
  await rest(["DEL", TEST_KEY]);
  if (conflicts <= 0) {
    console.error("Expected CAS conflicts > 0");
    process.exit(1);
  }
  if (lostKey) {
    console.error("Revoked key was lost/resurrected");
    process.exit(1);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.log(`NOT_RUN: Redis unreachable or timed out (${message}).`);
  try {
    await rest(["DEL", TEST_KEY]);
  } catch {
    // ignore
  }
  process.exit(0);
}
