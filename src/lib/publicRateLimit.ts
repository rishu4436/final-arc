import { defaultDistributedRateLimiter, distributedAllow, type DistributedRateLimiter } from "./distributedRateLimit";

/**
 * Phase 13 (P1-03 / P1-05): bounded rate limits for the legacy /api/pay,
 * /api/statement, and /api/receipt surfaces.
 *
 * Two layers (Batch 6):
 * 1. FixedWindowLimiter below is PROCESS-LOCAL. Counters live in this server
 *    process's memory, are not shared across instances, and reset on restart.
 *    It is always enforced first (also when Redis is down or unconfigured).
 * 2. legacyAllow() then applies the same per-key rule through the shared Redis
 *    counter in distributedRateLimit.ts (final-ratelimit:* keys, never the pay
 *    store), so multiple Vercel instances share one per-key quota. The global
 *    ceiling stays per-process.
 *
 * Each route class has a per-key limit and a per-process global ceiling. The
 * global ceiling is checked before a new per-key bucket is created, so the
 * number of tracked keys per window is bounded by the global limit. A client
 * cannot grow this map without bound by rotating keys.
 *
 * The per-key identity is a platform-provided client IP (Vercel only) or an
 * authenticated merchant. It is never a client-supplied merchant query value.
 */

export type RateRule = {
  /** Requests allowed per key per window. */
  perKey: number;
  /** Requests allowed per process per window for this route class. */
  global: number;
  windowSeconds: number;
};

/**
 * Conservative constants. Legitimate dashboard use is a handful of calls per
 * minute per merchant. Statement scans the Memo ledger on Arc, so it is lowest.
 */
export const LEGACY_RATE_RULES = {
  /** GET /api/pay?token= (public; stored row only — no reconciliation). */
  "pay.token_read": { perKey: 30, global: 600, windowSeconds: 60 },
  /** POST /api/pay register / view / cancel (public entry; cancel does not scan). */
  "pay.write": { perKey: 30, global: 600, windowSeconds: 60 },
  /** POST /api/pay action=submit (public; ≤2 RPC verify). Keyed by IP + token fingerprint. */
  "pay.submit": { perKey: 20, global: 400, windowSeconds: 60 },
  /** POST /api/pay action=reconcile (authenticated; single-row). Keyed by merchant. */
  "pay.reconcile": { perKey: 12, global: 120, windowSeconds: 60 },
  /** GET /api/pay?to= before authentication, keyed by client IP. */
  "pay.list_ip": { perKey: 30, global: 600, windowSeconds: 60 },
  /** GET /api/pay?to= after authentication, keyed by authenticated merchant. */
  "pay.list_merchant": { perKey: 20, global: 300, windowSeconds: 60 },
  /** GET /api/statement before authentication, keyed by client IP. */
  "statement.ip": { perKey: 10, global: 120, windowSeconds: 60 },
  /** GET /api/statement after authentication, keyed by authenticated merchant. */
  "statement.merchant": { perKey: 6, global: 60, windowSeconds: 60 },
  /** GET /api/receipt/[hash] (public chain proof; one RPC lookup). */
  "receipt.proof": { perKey: 60, global: 1200, windowSeconds: 60 },
} as const satisfies Record<string, RateRule>;

export type LegacyRouteClass = keyof typeof LEGACY_RATE_RULES;

type Bucket = { start: number; count: number };

export class FixedWindowLimiter<C extends string> {
  private readonly buckets = new Map<string, Bucket>();
  private calls = 0;

  constructor(
    private readonly rules: Record<C, RateRule>,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** True when the request is allowed. A denied request is not counted. */
  allow(routeClass: C, key: string): boolean {
    const rule = this.rules[routeClass];
    if (!rule) return false;
    const now = this.now();
    this.calls += 1;
    if (this.calls % 256 === 0) this.sweep(now);

    const globalSlot = `global\u0000${routeClass}`;
    const keySlot = `key\u0000${routeClass}\u0000${key}`;
    const global = this.live(globalSlot, now, rule.windowSeconds);
    const perKey = this.live(keySlot, now, rule.windowSeconds);

    if (perKey && perKey.count >= rule.perKey) return false;
    if (global && global.count >= rule.global) return false;

    if (global) global.count += 1;
    else this.buckets.set(globalSlot, { start: now, count: 1 });
    if (perKey) perKey.count += 1;
    else this.buckets.set(keySlot, { start: now, count: 1 });
    return true;
  }

  /** Number of tracked buckets. Exposed for tests. */
  size(): number {
    return this.buckets.size;
  }

  reset(): void {
    this.buckets.clear();
    this.calls = 0;
  }

  private live(slot: string, now: number, windowSeconds: number): Bucket | null {
    const bucket = this.buckets.get(slot);
    if (!bucket) return null;
    if (now - bucket.start >= windowSeconds) {
      this.buckets.delete(slot);
      return null;
    }
    return bucket;
  }

  private sweep(now: number): void {
    const longest = Math.max(...Object.values<RateRule>(this.rules).map((rule) => rule.windowSeconds));
    for (const [slot, bucket] of this.buckets) {
      if (now - bucket.start >= longest) this.buckets.delete(slot);
    }
  }
}

/** Shared process-local limiter for the legacy routes. */
export const legacyRateLimiter = new FixedWindowLimiter<LegacyRouteClass>(LEGACY_RATE_RULES);

/**
 * Process-local check first, then the shared per-key counter. A request denied
 * locally never touches Redis. Redis errors fall back to the local decision.
 */
export async function legacyAllow(
  routeClass: LegacyRouteClass,
  key: string,
  opts: {
    local?: FixedWindowLimiter<LegacyRouteClass>;
    distributed?: DistributedRateLimiter | null;
  } = {},
): Promise<boolean> {
  const local = opts.local ?? legacyRateLimiter;
  if (!local.allow(routeClass, key)) return false;
  const rule = LEGACY_RATE_RULES[routeClass];
  const distributed = opts.distributed === undefined ? defaultDistributedRateLimiter() : opts.distributed;
  return distributedAllow(distributed, `legacy.${routeClass}`, key, rule.perKey, rule.windowSeconds);
}

const IP_TEXT = /^[0-9A-Fa-f:.]{2,45}$/;

/**
 * Client identity for rate limiting.
 *
 * On Vercel (VERCEL=1) the platform sets x-vercel-forwarded-for / x-real-ip and
 * overwrites x-forwarded-for, so those are trusted. Anywhere else a forwarded
 * header is client-controlled and is NOT trusted: every caller shares one
 * "untrusted-proxy" bucket, so a spoofed header cannot mint fresh quota.
 */
export function requestClientKey(request: Request, env: Record<string, string | undefined> = process.env): string {
  if (env.VERCEL !== "1") return "ip:untrusted-proxy";
  for (const name of ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"]) {
    const raw = request.headers.get(name);
    if (!raw) continue;
    const first = raw.split(",")[0]?.trim() ?? "";
    if (IP_TEXT.test(first)) return `ip:${first.toLowerCase()}`;
  }
  return "ip:unknown";
}

export const RATE_LIMITED_MESSAGE = "Too many requests.";
