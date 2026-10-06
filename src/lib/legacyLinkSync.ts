import type { Address } from "viem";
import { decodePayLink } from "./payRequest";

/**
 * Phase 13 (P1-03). Browser helper for the merchant's locally remembered links.
 * Registers only tokens the server does not already hold. V2 links are accepted
 * on their own EIP-712 merchant signature. V1 links are unsigned, so they carry
 * the merchant's wallet authorization ("payments.register"), supplied by the
 * workspace session via `workspaceFetch`. If sign-in is declined, V1 links are
 * skipped (never sent unauthenticated).
 */
export async function registerMissingLinks(
  tokens: string[],
  merchant: Address,
  workspaceFetch: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<number> {
  void merchant;
  if (tokens.length === 0) return 0;
  const isV1 = (token: string) => decodePayLink(token)?.version === 1;
  const results = await Promise.all(
    tokens.map(async (token) => {
      const v1 = isV1(token);
      const bodyText = JSON.stringify({ token, action: "register" });
      const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: bodyText };
      const send = v1 ? () => workspaceFetch("/api/pay", init) : () => fetch("/api/pay", init);
      return send()
        .then((res) => res.ok)
        .catch(() => false);
    }),
  );
  return results.filter(Boolean).length;
}
