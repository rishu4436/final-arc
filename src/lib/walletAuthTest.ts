/**
 * Test helpers for P2-01 wallet authorization (nonce + payload digest).
 * Not imported by production routes.
 */
import { createHash, randomBytes } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WALLET_AUTH_HEADERS, walletAuthMessage, walletAuthPayloadInput, type WalletAction } from "./apiScopes";
import type { ApiKeyRuntime } from "./apiKeys";
import { walletPayloadDigest } from "./walletNonce";

export function memoryNonceConsumer(): {
  consume: (merchant: Address, nonce: string, nowSeconds: number) => Promise<boolean>;
  used: Set<string>;
} {
  const used = new Set<string>();
  return {
    used,
    async consume(merchant, nonce, _now) {
      const key = `${getAddress(merchant).toLowerCase()}:${nonce.toLowerCase()}`;
      if (used.has(key)) return false;
      used.add(key);
      return true;
    },
  };
}

export function withMemoryNonces<T extends ApiKeyRuntime>(runtime: T): T & { nonceBag: ReturnType<typeof memoryNonceConsumer> } {
  const bag = memoryNonceConsumer();
  return { ...runtime, consumeWalletNonce: bag.consume, nonceBag: bag };
}

export async function signedWalletRequest(opts: {
  account: { address: Address; signMessage: (args: { message: string }) => Promise<Hex> };
  action: WalletAction | string;
  url: string;
  method?: string;
  body?: unknown;
  timestamp?: number;
  nonce?: string;
  /** Tamper with the signed payload digest while sending a different body. */
  signBodyText?: string;
  extraHeaders?: Record<string, string>;
}): Promise<Request> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const bodyText =
    opts.body === undefined ? "" : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  const pathname = new URL(opts.url, "https://example.test").pathname;
  const signText = opts.signBodyText ?? bodyText;
  const digest = walletPayloadDigest(method, pathname, signText);
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? (`0x${randomBytes(32).toString("hex")}` as Hex);
  const merchant = getAddress(opts.account.address);
  const message = walletAuthMessage(opts.action, merchant, timestamp, nonce.toLowerCase(), digest);
  const signature = await opts.account.signMessage({ message });
  const headers = new Headers(opts.extraHeaders ?? {});
  if (method !== "GET" && method !== "HEAD") headers.set("content-type", "application/json");
  headers.set(WALLET_AUTH_HEADERS.merchant, merchant);
  headers.set(WALLET_AUTH_HEADERS.timestamp, String(timestamp));
  headers.set(WALLET_AUTH_HEADERS.signature, signature);
  headers.set(WALLET_AUTH_HEADERS.nonce, nonce);
  return new Request(opts.url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : bodyText,
  });
}

export function digestOf(method: string, path: string, body: string): string {
  return createHash("sha256").update(walletAuthPayloadInput(method, path, body), "utf8").digest("hex");
}

export { privateKeyToAccount };
