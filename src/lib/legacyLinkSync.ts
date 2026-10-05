import type { Address, Hex } from "viem";
import { WALLET_ACTIONS, WALLET_AUTH_HEADERS } from "./apiScopes";
import { decodePayLink } from "./payRequest";
import { cachedWalletHeaders } from "./walletAuthCache";

/**
 * Phase 13 (P1-03). Browser helper for the merchant's locally remembered links.
 * Registers only tokens the server does not already hold. V2 links are accepted
 * on their own EIP-712 merchant signature. V1 links are unsigned, so they carry
 * the existing wallet authorization header for action "payments.register".
 * If the wallet declines, V1 links are skipped (never sent unauthenticated).
 */
export async function registerMissingLinks(
  tokens: string[],
  merchant: Address,
  signMessage: (args: { message: string }) => Promise<Hex>,
): Promise<number> {
  if (tokens.length === 0) return 0;
  const isV1 = (token: string) => decodePayLink(token)?.version === 1;
  let v1Headers: Record<string, string> = {};
  if (tokens.some(isV1)) {
    try {
      v1Headers = await cachedWalletHeaders(WALLET_ACTIONS.paymentsRegister, merchant, signMessage);
    } catch {
      v1Headers = {};
    }
  }
  const results = await Promise.all(
    tokens.map((token) => {
      const v1 = isV1(token);
      if (v1 && !v1Headers[WALLET_AUTH_HEADERS.signature]) return Promise.resolve(false);
      return fetch("/api/pay", {
        method: "POST",
        headers: { "content-type": "application/json", ...(v1 ? v1Headers : {}) },
        body: JSON.stringify({ token, action: "register" }),
      })
        .then((res) => res.ok)
        .catch(() => false);
    }),
  );
  return results.filter(Boolean).length;
}
