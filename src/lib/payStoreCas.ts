/**
 * P1-02: optimistic compare-and-set for the shared final-pay-store blob.
 *
 * The optimistic concurrency token is the exact previous Redis/file raw string
 * ("" when missing). There is no numeric version field and no schema migration.
 *
 * Production safety comes from Redis REST EVAL of the Lua script below.
 * The file backend only serializes inside one process — it is not multi-instance safe.
 *
 * This module does not modify policyLedger.ts. The Lua text matches the ledger
 * CAS script so fake Redis and Upstash EVAL behave the same way.
 */

export const PAY_STORE_KEY = "final-pay-store";

/** Bounded optimistic retries for a single logical mutation. */
export const PAY_STORE_CAS_MAX_ATTEMPTS = 8;

/**
 * Lua compare-and-set. KEYS[1] store key, ARGV[1] expected raw ("" = missing),
 * ARGV[2] new raw. Returns 1 when written, 0 when the stored value differs.
 */
export const PAY_STORE_CAS_SCRIPT = [
  "local cur = redis.call('GET', KEYS[1])",
  "if cur == false then cur = '' end",
  "if cur ~= ARGV[1] then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[2])",
  "return 1",
].join("\n");

export class PayStoreCasExhaustedError extends Error {
  readonly code = "cas_exhausted" as const;
  constructor(message = "Payment store write conflict.") {
    super(message);
    this.name = "PayStoreCasExhaustedError";
  }
}

export class PayStoreUnavailableError extends Error {
  readonly code = "store_unavailable" as const;
  constructor(message = "Payment store is unavailable.") {
    super(message);
    this.name = "PayStoreUnavailableError";
  }
}

export class PayStoreMalformedError extends Error {
  readonly code = "store_malformed" as const;
  constructor(message = "Payment store read failed.") {
    super(message);
    this.name = "PayStoreMalformedError";
  }
}

export function isPayStorePersistenceError(
  err: unknown,
): err is PayStoreCasExhaustedError | PayStoreUnavailableError | PayStoreMalformedError {
  return (
    err instanceof PayStoreCasExhaustedError ||
    err instanceof PayStoreUnavailableError ||
    err instanceof PayStoreMalformedError
  );
}
