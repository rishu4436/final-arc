import { getAddress, type Address, type Hex } from "viem";
import type { WalletAction } from "./apiScopes";
import { signedWalletHeaders, type WalletAuthBinding } from "./signedWalletHeaders";

/**
 * Browser helper for FINAL wallet authorization headers.
 *
 * P2-01: every signature carries a one-time server-consumed nonce, so cached
 * reuse is unsafe and is not performed. Each call prompts (or uses the wallet
 * provider's own session) for a fresh signature bound to method/path/body.
 */
export const WALLET_SIGNATURE_REUSE_MS = 0;

export function cachedWalletHeaders(
  action: WalletAction,
  merchant: Address,
  signMessage: (args: { message: string }) => Promise<Hex>,
  binding: WalletAuthBinding,
  _now: number = Date.now(),
): Promise<Record<string, string>> {
  void _now;
  void getAddress(merchant);
  return signedWalletHeaders(action, merchant, signMessage, binding);
}

/** No-op retained for call sites that drop a rejected signature. */
export function forgetWalletHeaders(_action: WalletAction, _merchant: Address): void {
  /* single-use nonces — nothing to forget */
}
