/**
 * Phase 13 (P1-03 / P1-05): bounded rate limits for the legacy /api/pay,
 * /api/statement, and /api/receipt surfaces.
 *
 * PROCESS-LOCAL ONLY. Counters live in this server process's memory. They are
 * not shared across Vercel instances, regions, or cold starts, and they reset on
 * restart. This is a mitigation, not a distributed quota. A distributed limiter
 * needs shared atomic storage (Phase 13 P1-02) and is not built here.
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
  /** GET /api/pay?token= (public; reconciles one existing row). */
  "pay.token_read": { perKey: 30, global: 600, windowSeconds: 60 },
  /** POST /api/pay register / view / cancel (public entry; cancel may scan one V2 request). */
  "pay.write": { perKey: 30, global: 600, windowSeconds: 60 },
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
