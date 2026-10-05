import { getAddress, isAddress, type Address } from "viem";
import { decodePayLink } from "./payRequest";
import type { PayRecord } from "./payStore";

/**
 * Phase 13 (P1-03): per-merchant resource caps.
 *
 * These are ceilings on stored rows, checked at creation time. They stop one
 * merchant identity from growing the shared pay-store blob without bound. They
 * do not stop many distinct wallets (sybil) from each creating rows up to the
 * cap; the process-local rate limits in publicRateLimit.ts and the API-key rate
 * limit in apiKeys.ts are the mitigation for that. A global quota needs shared
 * atomic storage (P1-02) and is not built here.
 *
 * The count-then-write check runs on the existing non-atomic blob. Two
 * concurrent creates can each pass at cap - 1 (overshoot by the number of
 * concurrent writers). That is the known P1-02 limitation, not a new one.
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

export const LIMIT_EXCEEDED_CODE = "limit_exceeded";

/**
 * Who owns a stored payment row.
 * V2: the merchant inside the signed request (signature is verified at registration).
 * V1: the payee address decoded from the token, the legacy owner semantics.
 * Undecodable rows have no owner.
 */
export function payRecordOwner(row: Pick<PayRecord, "token" | "to">): Address | null {
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

export function ownsPayRecord(row: Pick<PayRecord, "token" | "to">, merchant: Address): boolean {
  const owner = payRecordOwner(row);
  return owner !== null && owner === getAddress(merchant);
}

/** One pass over already-loaded rows. No per-row store reads. */
export function countPayRecordsOwnedBy(rows: Iterable<Pick<PayRecord, "token" | "to">>, merchant: Address): number {
  const needle = getAddress(merchant);
  let count = 0;
  for (const row of rows) {
    if (!row || typeof row.token !== "string") continue;
    if (payRecordOwner(row) === needle) count += 1;
  }
  return count;
}
