import { ARC_CHAIN_ID } from "./arc";

/**
 * Merchant workspace session: constants and the sign-in message format shared by
 * the browser and the server. No server or secret dependencies.
 *
 * The workspace session is "this browser proved control of merchant wallet X once".
 * It is never a blockchain signing credential. Transactions (sendTransaction,
 * writeContract, USDC transfers, escrow fund/release/refund) and protocol
 * signatures (V2 EIP-712 requests, cancellations) still go through the wallet.
 */

export const WORKSPACE_SESSION_PATH = "/api/v1/session";
export const WORKSPACE_CHALLENGE_PATH = "/api/v1/session/challenge";

/**
 * Required on every session-authenticated request. Names the wallet the browser
 * currently has connected. The server rejects a session whose merchant differs
 * (wallet changed), and a cross-site page cannot set a custom header without a
 * CORS preflight FINAL never approves (CSRF defence in depth with SameSite=Strict).
 */
export const WORKSPACE_SESSION_MERCHANT_HEADER = "x-final-session-merchant";

/** Absolute session lifetime. No sliding renewal. */
export const WORKSPACE_SESSION_TTL_SECONDS = 8 * 60 * 60;
/** A sign-in challenge must be signed and returned within this window. */
export const WORKSPACE_CHALLENGE_TTL_SECONDS = 5 * 60;

/** `__Host-` pins the cookie to this exact host, path "/", Secure, no Domain attribute. */
export function workspaceSessionCookieName(secure: boolean): string {
  return secure ? "__Host-final_workspace" : "final_workspace";
}

export type WorkspaceChallengeFields = {
  /** Host (and port) the browser is on, e.g. final-arc-eight.vercel.app. */
  domain: string;
  /** Origin, e.g. https://final-arc-eight.vercel.app. */
  uri: string;
  /** EIP-55 checksummed merchant wallet. */
  address: string;
  /** 64 lowercase hex chars (no 0x), server generated. */
  nonce: string;
  issuedAt: number;
  expiresAt: number;
};

export const WORKSPACE_SIGN_IN_STATEMENT =
  "Sign in to the FINAL merchant workspace. This creates a browser session only. " +
  "It does not authorize any payment, transaction, or token approval.";

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** EIP-4361 (Sign-In with Ethereum) message. Wallets show the domain and warn on mismatch. */
export function buildWorkspaceSignInMessage(fields: WorkspaceChallengeFields): string {
  return [
    `${fields.domain} wants you to sign in with your Ethereum account:`,
    fields.address,
    "",
    WORKSPACE_SIGN_IN_STATEMENT,
    "",
    `URI: ${fields.uri}`,
    "Version: 1",
    `Chain ID: ${ARC_CHAIN_ID}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${iso(fields.issuedAt)}`,
    `Expiration Time: ${iso(fields.expiresAt)}`,
  ].join("\n");
}
