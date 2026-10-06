import type { NextConfig } from "next";
import { NO_REFERRER_SOURCES, securityHeaders } from "./src/lib/securityHeaders";

const isDev = process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@circle-fin/bridge-kit", "@circle-fin/adapter-viem-v2"],
  // Phase 13 (P3-05): security headers on every route.
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders(isDev) },
      ...NO_REFERRER_SOURCES.map((source) => ({
        source,
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      })),
    ];
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/evm/upto/client": false,
      "@x402/evm/exact/client": false,
      "@x402/core/client": false,
      "@x402/svm/exact/client": false,
      "@x402/evm": false,
    };
    return config;
  },
};

export default nextConfig;
