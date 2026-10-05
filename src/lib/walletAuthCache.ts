import { getAddress, type Address, type Hex } from "viem";
import { WALLET_AUTH_TOLERANCE_SECONDS, type WalletAction } from "./apiScopes";
import { signedWalletHeaders } from "./signedWalletHeaders";

/**
 * Browser-side reuse of the existing FINAL wallet authorization headers.
 * No new protocol: this calls signedWalletHeaders (same message the server
 * rebuilds in recoverWalletMerchant). It only avoids prompting the wallet on
 * every dashboard fetch by reusing one signature per (action, merchant) for
 * 4 minutes, inside the server's 300-second window. Concurrent callers share
 * one pending prompt. Nothing is persisted; the cache is this tab's memory.
 */
export const WALLET_SIGNATURE_REUSE_MS = Math.min(4 * 60 * 1000, (WALLET_AUTH_TOLERANCE_SECONDS - 30) * 1000);

type Entry = { at: number; headers: Promise<Record<string, string>> };
const cache = new Map<string, Entry>();

function slot(action: WalletAction, merchant: Address): string {
  return `${action}\u0000${getAddress(merchant)}`;
}

export function cachedWalletHeaders(
  action: WalletAction,
  merchant: Address,
  signMessage: (args: { message: string }) => Promise<Hex>,
  now: number = Date.now(),
): Promise<Record<string, string>> {
  const key = slot(action, merchant);
  const hit = cache.get(key);
  if (hit && now - hit.at < WALLET_SIGNATURE_REUSE_MS) return hit.headers;
  const headers = signedWalletHeaders(action, merchant, signMessage);
  cache.set(key, { at: now, headers });
  headers.catch(() => {
    if (cache.get(key)?.headers === headers) cache.delete(key);
  });
  return headers;
}

/** Drop a cached signature, e.g. after the server rejects it. */
export function forgetWalletHeaders(action: WalletAction, merchant: Address): void {
  cache.delete(slot(action, merchant));
}
