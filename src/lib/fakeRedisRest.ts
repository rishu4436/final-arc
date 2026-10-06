import { LEDGER_CAS_SCRIPT } from "./policyLedger";
import { PAY_STORE_CAS_SCRIPT } from "./payStoreCas";
import { RATE_LIMIT_INCR_SCRIPT } from "./distributedRateLimit";

/**
 * Test-only in-memory stand-in for the Upstash/Vercel KV REST interface.
 * Supports GET /get/<key> and POST ["EVAL", <CAS script>, "1", key, expected, next]
 * with the same compare-and-set semantics the Lua script has inside Redis.
 * Accepts both the policy-ledger and pay-store CAS scripts (identical Lua).
 * Each response yields to the event loop first so concurrent callers interleave.
 * Not a real Redis. No network.
 */
export type FakeRedis = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  values: Map<string, string>;
  /** Next N EVALs: another writer changes the key first, so the CAS returns 0. */
  injectConflicts(count: number): void;
  evalCalls: number;
  conflictsReturned: number;
  /** TTL seconds set by the rate-limit INCR script (key -> seconds). */
  ttls: Map<string, number>;
  rateLimitCalls: number;
};

const CAS_SCRIPTS = new Set([LEDGER_CAS_SCRIPT, PAY_STORE_CAS_SCRIPT]);

function json(result: unknown): Response {
  return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
}

export function createFakeRedis(): FakeRedis {
  const values = new Map<string, string>();
  let pendingConflicts = 0;
  const fake: FakeRedis = {
    values,
    evalCalls: 0,
    conflictsReturned: 0,
    ttls: new Map<string, number>(),
    rateLimitCalls: 0,
    injectConflicts(count) {
      pendingConflicts += count;
    },
    async fetch(input, init) {
      await new Promise((resolve) => setImmediate(resolve));
      const url = new URL(input);
      if (url.pathname.startsWith("/get/")) {
        const key = decodeURIComponent(url.pathname.slice(5));
        return json(values.get(key) ?? null);
      }
      if ((init?.method ?? "GET") === "POST" && url.pathname === "/") {
        const command = JSON.parse(String(init?.body)) as string[];
        if (command[0] === "EVAL" && command[1] === RATE_LIMIT_INCR_SCRIPT && command[2] === "1") {
          // Same semantics as the Lua script: INCR, then EXPIRE on first hit. Atomic here
          // because this block has no await between read and write.
          fake.rateLimitCalls += 1;
          const [, , , key, ttl] = command;
          const next = Number(values.get(key) ?? "0") + 1;
          values.set(key, String(next));
          if (next === 1 || !fake.ttls.has(key)) fake.ttls.set(key, Number(ttl));
          return json(next);
        }
        if (command[0] !== "EVAL" || !CAS_SCRIPTS.has(command[1]) || command[2] !== "1") {
          return new Response(JSON.stringify({ error: "unsupported" }), { status: 400 });
        }
        fake.evalCalls += 1;
        const [, , , key, expected, next] = command;
        if (pendingConflicts > 0) {
          pendingConflicts -= 1;
          fake.conflictsReturned += 1;
          // Model a lost race: the caller's EVAL is rejected and nothing is written.
          // The stored value is left as is, so the retry re-reads real state.
          return json(0);
        }
        const current = values.get(key) ?? "";
        if (current !== expected) {
          fake.conflictsReturned += 1;
          return json(0);
        }
        values.set(key, next);
        return json(1);
      }
      return new Response("not found", { status: 404 });
    },
  };
  return fake;
}
