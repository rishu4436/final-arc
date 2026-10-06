import { getAddress, type Address, type Hex } from "viem";
import {
  WALLET_AUTH_HEADERS,
  walletAuthMessage,
  walletAuthPayloadInput,
  type WalletAction,
} from "./apiScopes";

export type WalletAuthBinding = {
  method: string;
  /** URL pathname only (e.g. /api/v1/api-keys). */
  path: string;
  /** Exact raw body string that will be sent; empty for GET/HEAD/DELETE without body. */
  body?: string;
};

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Headers for dashboard calls. The server rebuilds the same message (action,
 * merchant, timestamp, nonce, payload digest) and recovers the signer.
 * Each call uses a fresh nonce — signatures are single-use (P2-01).
 */
export async function signedWalletHeaders(
  action: WalletAction,
  merchant: Address,
  signMessage: (args: { message: string }) => Promise<Hex>,
  binding: WalletAuthBinding,
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000);
  const checksum = getAddress(merchant);
  const bodyText = binding.body ?? "";
  const payloadDigest = await sha256Hex(walletAuthPayloadInput(binding.method, binding.path, bodyText));
  const nonce = randomNonce();
  const signature = await signMessage({
    message: walletAuthMessage(action, checksum, timestamp, nonce, payloadDigest),
  });
  return {
    [WALLET_AUTH_HEADERS.merchant]: checksum,
    [WALLET_AUTH_HEADERS.timestamp]: String(timestamp),
    [WALLET_AUTH_HEADERS.signature]: signature,
    [WALLET_AUTH_HEADERS.nonce]: nonce,
  };
}
