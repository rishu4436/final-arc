/**
 * P2-01: atomic one-time wallet-auth nonce consumption in the shared pay store.
 * Nonces are consumed only after signature recovery succeeds. Concurrent reuse
 * of the same nonce fails closed (only one CAS writer wins).
 */
import { createHash } from "node:crypto";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { WALLET_AUTH_TOLERANCE_SECONDS } from "./apiScopes";
import { mutatePayStoreBlob, type StoreFile, type WalletAuthStoreSection } from "./payStore";

/** Keep used nonces slightly longer than the signature window so late retries still collide. */
export const WALLET_NONCE_RETENTION_SECONDS = WALLET_AUTH_TOLERANCE_SECONDS + 60;

export function walletPayloadDigest(method: string, path: string, bodyText: string): string {
  const input = `${method.toUpperCase()}\n${path}\n${bodyText}`;
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function isWalletNonce(value: string): value is Hex {
  return isHex(value, { strict: true }) && value.length === 66;
}

function nonceKey(merchant: Address, nonce: string): string {
  return `${merchant.toLowerCase()}:${nonce.toLowerCase()}`;
}

export function ensureWalletAuthSection(store: StoreFile): WalletAuthStoreSection {
  if (!store.walletAuth || typeof store.walletAuth !== "object" || Array.isArray(store.walletAuth)) {
    store.walletAuth = { nonces: {} };
  }
  if (!store.walletAuth.nonces || typeof store.walletAuth.nonces !== "object" || Array.isArray(store.walletAuth.nonces)) {
    store.walletAuth.nonces = {};
  }
  return store.walletAuth;
}

function pruneExpired(section: WalletAuthStoreSection, nowSeconds: number): void {
  for (const [key, exp] of Object.entries(section.nonces)) {
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= nowSeconds) {
      delete section.nonces[key];
    }
  }
}

/**
 * Atomically mark a nonce used. Returns true when this caller consumed it.
 * Returns false when the nonce was already present (replay).
 */
export async function consumeWalletNonce(merchant: Address, nonce: string, nowSeconds: number): Promise<boolean> {
  if (!isAddress(merchant) || !isWalletNonce(nonce)) return false;
  const key = nonceKey(getAddress(merchant), nonce);
  const expiresAt = nowSeconds + WALLET_NONCE_RETENTION_SECONDS;
  let consumed = false;
  await mutatePayStoreBlob((store) => {
    consumed = false;
    const section = ensureWalletAuthSection(store);
    // Opportunistic prune (~every write) keeps the map bounded without a full scan path.
    if (Object.keys(section.nonces).length > 0 && Object.keys(section.nonces).length % 32 === 0) {
      pruneExpired(section, nowSeconds);
    } else {
      // Always drop clearly expired entries for this merchant prefix cheaply.
      for (const [k, exp] of Object.entries(section.nonces)) {
        if (typeof exp !== "number" || exp <= nowSeconds) delete section.nonces[k];
      }
    }
    if (section.nonces[key] !== undefined && section.nonces[key]! > nowSeconds) {
      return;
    }
    section.nonces[key] = expiresAt;
    consumed = true;
  });
  return consumed;
}

/** Test helper: fingerprint without revealing the secret. */
export function preAuthBucketKey(tokenPrefix: string): string {
  return createHash("sha256").update(tokenPrefix, "utf8").digest("hex").slice(0, 32);
}
