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
} as const;

export type WalletAction = (typeof WALLET_ACTIONS)[keyof typeof WALLET_ACTIONS];

/** Canonical message. The server rebuilds it from the action, checksum merchant, and timestamp. */
export function walletAuthMessage(action: string, merchant: string, timestamp: number): string {
  return `FINAL wallet authorization\naction:${action}\nmerchant:${merchant}\ntimestamp:${timestamp}`;
}

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

export function routeClassForScope(scope: ApiScope): string {
  return scope.slice(0, scope.indexOf(":"));
}
