import { getAddress, isAddress, type Address } from "viem";
import { decodePayLink } from "./payRequest";

type PayRecordRef = { token: string; to: string };

/**
 * Phase 13 (P1-03): per-merchant resource caps.
 *
 * These are ceilings on stored rows, checked at creation time inside the
 * pay-store CAS mutator (P1-02). They stop one merchant identity from growing
 * the shared pay-store blob without bound. They do not stop many distinct
 * wallets (sybil) from each creating rows up to the cap; the process-local
 * rate limits in publicRateLimit.ts and the API-key rate limit in apiKeys.ts
 * are the mitigation for that.
 *
 * Cap checks must run against the latest CAS snapshot so concurrent creates
 * cannot overshoot the configured ceilings.
 */

/** Stored payment-request rows owned by one merchant (V2 signer, V1 payee). */
export const MAX_PAYMENT_RECORDS_PER_MERCHANT = 10_000;
/** Non-revoked API keys per merchant. */
export const MAX_ACTIVE_API_KEYS_PER_MERCHANT = 25;
/** All stored API key rows per merchant, including revoked ones (revoke is a soft delete). */
export const MAX_STORED_API_KEYS_PER_MERCHANT = 200;
/** Webhook endpoints per merchant. Delete removes the row. */
export const MAX_WEBHOOK_ENDPOINTS_PER_MERCHANT = 20;
/** Payment policies per merchant. Delete removes the row. */
export const MAX_POLICIES_PER_MERCHANT = 50;
/**
 * P2-04: bounded denial audit history per merchant (oldest dropped on write).
 * Active spend reservations are never pruned here.
 */
export const MAX_POLICY_DENIALS_PER_MERCHANT = 500;
/**
 * P2-04: bounded agent idempotency rows per merchant (oldest dropped on write).
 * Intent rows themselves are not pruned by this ceiling.
 */
export const MAX_AGENT_IDEMPOTENCY_PER_MERCHANT = 500;

export const LIMIT_EXCEEDED_CODE = "limit_exceeded";

/** Thrown inside a CAS mutator when a create would exceed a configured ceiling. */
export class ResourceLimitExceededError extends Error {
  readonly status = 409 as const;
  readonly code = LIMIT_EXCEEDED_CODE;

  constructor(message: string) {
    super(message);
    this.name = "ResourceLimitExceededError";
  }
}

/**
 * Who owns a stored payment row.
 * V2: the merchant inside the signed request (signature is verified at registration).
 * V1: the payee address decoded from the token, the legacy owner semantics.
 * Undecodable rows have no owner.
 */
export function payRecordOwner(row: PayRecordRef): Address | null {
  let link: ReturnType<typeof decodePayLink>;
  try {
    link = decodePayLink(row.token);
  } catch {
    return null;
  }
  if (!link) return null;
  if (link.version === 2) return getAddress(link.request.merchant);
  const payee = link.request.to;
  return typeof payee === "string" && isAddress(payee) ? getAddress(payee) : null;
}

export function ownsPayRecord(row: PayRecordRef, merchant: Address): boolean {
  const owner = payRecordOwner(row);
  return owner !== null && owner === getAddress(merchant);
}

/** One pass over already-loaded rows. No per-row store reads. */
export function countPayRecordsOwnedBy(rows: Iterable<PayRecordRef>, merchant: Address): number {
  const needle = getAddress(merchant);
  let count = 0;
  for (const row of rows) {
    if (!row || typeof row.token !== "string") continue;
    if (payRecordOwner(row) === needle) count += 1;
  }
  return count;
}
