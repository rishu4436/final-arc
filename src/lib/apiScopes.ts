/**
 * Programmatic scopes and the wallet-signature message the dashboard signs.
 * This module has no server or secret dependencies so client components can import it.
 *
 * FINAL_API_KEY_PEPPER is the server HMAC pepper for API key hashes. It is not a scope
 * and it is never sent to the browser. See src/lib/apiKeys.ts.
 */

export const API_SCOPES = [
  "payment_requests:read",
  "payment_requests:write",
  "receipts:read",
  "verification:read",
  "webhooks:read",
  "webhooks:write",
  "escrow:read",
  "escrow:write",
  "agent:read",
  "agent:write",
  "policies:read",
  "policies:write",
  /** Phase 12. Read-only derived analytics. Opt-in: not a default and not implied by any other scope. */
  "analytics:read",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** Write scopes are off unless the merchant explicitly selects them. */
export const DEFAULT_API_KEY_SCOPES: readonly ApiScope[] = [
  "payment_requests:read",
  "receipts:read",
  "verification:read",
  "webhooks:read",
];

export const WALLET_AUTH_TOLERANCE_SECONDS = 300;

export const WALLET_AUTH_HEADERS = {
  merchant: "x-final-wallet-merchant",
  timestamp: "x-final-wallet-timestamp",
  signature: "x-final-wallet-signature",
  /** One-time server-consumed nonce (32-byte hex). Required for every wallet auth. */
  nonce: "x-final-wallet-nonce",
} as const;

export const WALLET_ACTIONS = {
  apiKeysCreate: "api_keys.create",
  apiKeysList: "api_keys.list",
  apiKeysGet: "api_keys.get",
  apiKeysUpdate: "api_keys.update",
  apiKeysDelete: "api_keys.delete",
  apiKeysRotate: "api_keys.rotate",
  webhooksCreate: "webhooks.create",
  webhooksList: "webhooks.list",
  webhooksGet: "webhooks.get",
  webhooksUpdate: "webhooks.update",
  webhooksDelete: "webhooks.delete",
  webhooksTest: "webhooks.test",
  webhooksDeliveries: "webhooks.deliveries",
  escrowsCreate: "escrows.create",
  escrowsList: "escrows.list",
  escrowsGet: "escrows.get",
  escrowsProof: "escrows.proof",
  escrowsOpen: "escrows.open",
  escrowsFund: "escrows.fund",
  escrowsRelease: "escrows.release",
  escrowsRefund: "escrows.refund",
  escrowsCancel: "escrows.cancel",
  policiesCreate: "policies.create",
  policiesList: "policies.list",
  policiesGet: "policies.get",
  policiesUpdate: "policies.update",
  policiesDelete: "policies.delete",
  analyticsRead: "analytics.read",
  /**
   * Phase 13. Legacy merchant-scoped reads: GET /api/pay?to= and GET /api/statement.
   * The signed merchant must equal the requested payee address.
   */
  paymentsRead: "payments.read",
  /** Phase 13. Legacy V1 link registration (POST /api/pay register). V1 links are unsigned. */
  paymentsRegister: "payments.register",
} as const;

export type WalletAction = (typeof WALLET_ACTIONS)[keyof typeof WALLET_ACTIONS];

/**
 * Canonical wallet-auth message (P2-01).
 * Binds action, merchant, timestamp, one-time nonce, and a payload digest of
 * METHOD + path + raw body so a captured signature cannot authorize a different
 * write. The server rebuilds this string and recovers the signer.
 */
export function walletAuthMessage(
  action: string,
  merchant: string,
  timestamp: number,
  nonce: string,
  payloadDigest: string,
): string {
  return (
    `FINAL wallet authorization\n` +
    `action:${action}\n` +
    `merchant:${merchant}\n` +
    `timestamp:${timestamp}\n` +
    `nonce:${nonce}\n` +
    `payload:${payloadDigest}`
  );
}

/** UTF-8 input hashed (SHA-256 hex) for the payload field. Browser and server must agree. */
export function walletAuthPayloadInput(method: string, path: string, bodyText: string): string {
  return `${method.toUpperCase()}\n${path}\n${bodyText}`;
}

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

export function routeClassForScope(scope: ApiScope): string {
  return scope.slice(0, scope.indexOf(":"));
}
