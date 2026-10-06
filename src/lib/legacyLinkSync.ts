import type { Address, Hex } from "viem";
import { WALLET_ACTIONS } from "./apiScopes";
import { decodePayLink } from "./payRequest";
import { cachedWalletHeaders } from "./walletAuthCache";

/**
 * Phase 13 (P1-03). Browser helper for the merchant's locally remembered links.
 * Registers only tokens the server does not already hold. V2 links are accepted
 * on their own EIP-712 merchant signature. V1 links are unsigned, so they carry
 * the existing wallet authorization header for action "payments.register".
 * If the wallet declines, V1 links are skipped (never sent unauthenticated).
 *
 * P2-01: each V1 register uses a fresh single-use wallet signature bound to that
 * request body (nonce + payload digest).
 */
export async function registerMissingLinks(
  tokens: string[],
  merchant: Address,
  signMessage: (args: { message: string }) => Promise<Hex>,
): Promise<number> {
  if (tokens.length === 0) return 0;
  const isV1 = (token: string) => decodePayLink(token)?.version === 1;
  const results = await Promise.all(
    tokens.map(async (token) => {
      const v1 = isV1(token);
      const bodyText = JSON.stringify({ token, action: "register" });
      let headers: Record<string, string> = { "content-type": "application/json" };
      if (v1) {
        try {
          const wallet = await cachedWalletHeaders(WALLET_ACTIONS.paymentsRegister, merchant, signMessage, {
            method: "POST",
            path: "/api/pay",
            body: bodyText,
          });
          headers = { ...headers, ...wallet };
        } catch {
          return false;
        }
      }
      return fetch("/api/pay", {
        method: "POST",
        headers,
        body: bodyText,
      })
        .then((res) => res.ok)
        .catch(() => false);
    }),
  );
  return results.filter(Boolean).length;
}
