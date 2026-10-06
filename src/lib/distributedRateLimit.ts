import { createHash } from "node:crypto";
import { payStoreBackend } from "./payStore";

/**
 * Phase 13 (Batch 6): shared fixed-window rate limits across Vercel instances.
 *
 * Storage: the existing Upstash/Vercel KV REST endpoint, but ONLY under keys that
 * start with RATE_LIMIT_KEY_PREFIX. It never reads or writes the pay-store blob key.
 *
 * Key shape: final-ratelimit:v1:<routeClass>:<sha256(identity)[0..32]>:<windowIndex>
 * - The identity (client IP, API key id, API-key prefix) is hashed, so no raw IP,
 *   key id, or API-key material is stored in Redis key names.
 * - One key per identity per window. Every key gets a TTL of window + grace on its
 *   first INCR inside one Lua EVAL (atomic increment + expiry), so keys cannot
 *   accumulate without bound and concurrent instances share one counter.
 *
 * Layering and outage behaviour (documented choice):
 * - The process-local limiter is ALWAYS checked first and still enforces its own
 *   per-instance limits. The distributed counter is a second, shared layer.
 * - If Redis is unconfigured (file/local dev backend) the decision is process-local only.
 * - If Redis is configured but the call fails or times out, the request falls back to
 *   the process-local decision ("fail-open to local"). Pre-auth/API-key abuse is still
 *   bounded per instance by the local limiter; a Redis outage does not take the API down.
 */

export const RATE_LIMIT_KEY_PREFIX = "final-ratelimit:v1:";
export const RATE_LIMIT_TTL_GRACE_SECONDS = 5;
export const RATE_LIMIT_REDIS_TIMEOUT_MS = 1_500;

/** Atomic INCR + EXPIRE. Re-arms a TTL if a key somehow has none (TTL -1). */
export const RATE_LIMIT_INCR_SCRIPT =
  "local c = redis.call('INCR', KEYS[1]) " +
  "if c == 1 or redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end " +
  "return c";

export type DistributedDecision = "allow" | "deny" | "unavailable";

export type DistributedRateLimiter = {
  readonly kind: "redis";
  hit(routeClass: string, identity: string, limit: number, windowSeconds: number): Promise<DistributedDecision>;
};

const ROUTE_CLASS = /^[a-z0-9._-]{1,64}$/;

export function identityFingerprint(identity: string): string {
  return createHash("sha256").update(`final-ratelimit:${identity}`, "utf8").digest("hex").slice(0, 32);
}

export function rateLimitKey(routeClass: string, identity: string, windowSeconds: number, nowSeconds: number): string {
  if (!ROUTE_CLASS.test(routeClass)) throw new Error("Invalid rate-limit route class.");
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1) throw new Error("Invalid rate-limit window.");
  const windowIndex = Math.floor(nowSeconds / windowSeconds);
  return `${RATE_LIMIT_KEY_PREFIX}${routeClass}:${identityFingerprint(identity)}:${windowIndex}`;
}

export type RedisRateLimiterOptions = {
  url: string;
  token: string;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  nowSeconds?: () => number;
  timeoutMs?: number;
};

export function createRedisRateLimiter(opts: RedisRateLimiterOptions): DistributedRateLimiter {
  const doFetch = opts.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const now = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const base = opts.url.replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? RATE_LIMIT_REDIS_TIMEOUT_MS;
  return {
    kind: "redis",
    async hit(routeClass, identity, limit, windowSeconds) {
      let key: string;
      try {
        key = rateLimitKey(routeClass, identity, windowSeconds, now());
      } catch {
        return "unavailable";
      }
      const ttl = String(windowSeconds + RATE_LIMIT_TTL_GRACE_SECONDS);
      try {
        const res = await doFetch(base, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(["EVAL", RATE_LIMIT_INCR_SCRIPT, "1", key, ttl]),
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
        });
        if (!res.ok) {
          try {
            await res.body?.cancel();
          } catch {
            /* ignore */
          }
          return "unavailable";
        }
        const body = (await res.json()) as { result?: unknown };
        const count = typeof body?.result === "number" ? body.result : Number(body?.result);
        if (!Number.isFinite(count) || count < 1) return "unavailable";
        return count > limit ? "deny" : "allow";
      } catch {
        return "unavailable";
      }
    },
  };
}

let cached: { url: string; limiter: DistributedRateLimiter } | null = null;

/**
 * The shared limiter for this deployment, or null when the pay store runs on the local
 * JSON file (dev/tests): limits are then process-local only.
 */
export function defaultDistributedRateLimiter(): DistributedRateLimiter | null {
  const backend = payStoreBackend();
  if (backend.kind !== "redis") return null;
  if (cached && cached.url === backend.url) return cached.limiter;
  const limiter = createRedisRateLimiter({ url: backend.url, token: backend.token });
  cached = { url: backend.url, limiter };
  return limiter;
}

/** True unless the shared counter explicitly says the identity is over its limit. */
export async function distributedAllow(
  limiter: DistributedRateLimiter | null | undefined,
  routeClass: string,
  identity: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  if (!limiter) return true;
  const decision = await limiter.hit(routeClass, identity, limit, windowSeconds);
  return decision !== "deny";
}
