import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@circle-fin/bridge-kit", "@circle-fin/adapter-viem-v2"],
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

