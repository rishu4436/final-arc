/**
 * Phase 13 (P3-05): HTTP security headers applied to every route via next.config.ts.
 *
 * Tuned to FINAL:
 * - No page may be framed (frame-ancestors 'none' + X-Frame-Options DENY): checkout,
 *   dashboard, and wallet-signing flows are clickjacking targets.
 * - Scripts are same-origin. 'unsafe-inline' is required for Next.js App Router inline
 *   bootstrap/RSC scripts without a nonce pipeline; 'unsafe-eval' is added only in dev.
 * - connect-src allows https:/wss: because wallets (injected), wagmi public chain RPCs,
 *   the Arc RPC, and Circle bridge-kit APIs are cross-origin HTTPS endpoints.
 * - No iframes, plugins, or cross-origin form posts.
 * - Payment links carry a token in the path, so /p and /r pages send no Referer.
 */
export type HeaderEntry = { key: string; value: string };

export function contentSecurityPolicy(dev: boolean): string {
  const scriptSrc = ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])].join(" ");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' https: wss:${dev ? " ws: http://localhost:* http://127.0.0.1:*" : ""}`,
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function securityHeaders(dev: boolean): HeaderEntry[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(dev) },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
  ];
}

/** Token-bearing payment/receipt pages: never leak the path via Referer. */
export const NO_REFERRER_SOURCES = ["/p/:path*", "/r/:path*"] as const;
