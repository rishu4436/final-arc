import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getAddress, type Address, type Hash } from "viem";
import {
  MAX_PAYMENT_RECORDS_PER_MERCHANT,
  ResourceLimitExceededError,
  countPayRecordsOwnedBy,
} from "./resourceLimits";
import {
  PAY_STORE_CAS_MAX_ATTEMPTS,
  PAY_STORE_CAS_SCRIPT,
  PAY_STORE_KEY,
  PayStoreCasExhaustedError,
  PayStoreMalformedError,
  PayStoreUnavailableError,
} from "./payStoreCas";

export {
  PAY_STORE_CAS_MAX_ATTEMPTS,
  PAY_STORE_CAS_SCRIPT,
  PAY_STORE_KEY,
  PayStoreCasExhaustedError,
  PayStoreMalformedError,
  PayStoreUnavailableError,
  isPayStorePersistenceError,
} from "./payStoreCas";

export { ResourceLimitExceededError, LIMIT_EXCEEDED_CODE, MAX_PAYMENT_RECORDS_PER_MERCHANT } from "./resourceLimits";

export type PayRecord = {
  token: string;
  id: string;
  to: Address;
  amount: string;
  memo: string;
  createdAt: string;
  views: number;
  lastViewedAt: string | null;
  cancelled: boolean;
  cancelledAt: string | null;
  paidTx: Hash | null;
  webhookUrl: string | null;
};

/** Optional webhooks section. Old blobs omit it. Payment list APIs never return it. */
export type WebhookStoreSection = {
  endpoints: Record<string, unknown>;
  deliveries: Record<string, unknown>;
};

/** Optional API key section. Old blobs omit it. Payment list APIs never return it. Secrets are hashes. */
export type ApiKeyStoreSection = {
  keys: Record<string, unknown>;
};

/** Optional escrow section. Not part of PayRecord. Old blobs omit it. */
export type EscrowStoreSection = {
  records: Record<string, unknown>;
};

/**
 * Optional machine-payment section. Not part of PayRecord.
 * Old blobs omit it. Idempotency lives here, in the same JSON or Redis blob.
 */
export type AgentStoreSection = {
  intents: Record<string, unknown>;
  idempotency: Record<string, unknown>;
};

/**
 * Optional policy section. Not part of PayRecord.
 * Reservations are authorization accounting only. They are not balances.
 * Old blobs omit this section.
 */
export type PolicyStoreSection = {
  records: Record<string, unknown>;
  reservations: Record<string, unknown>;
  denials: Record<string, unknown>;
};

export type StoreFile = {
  records: Record<string, PayRecord>;
  /** Merchant webhook endpoints and delivery log. Not part of PayRecord. */
  webhooks?: WebhookStoreSection;
  /** Developer API keys. Not part of PayRecord. Plaintext secrets are never stored. */
  apiKeys?: ApiKeyStoreSection;
  /** Escrow agreements. Not part of PayRecord. */
  escrows?: EscrowStoreSection;
  /** Machine payment intents and idempotency. Not part of PayRecord. */
  agents?: AgentStoreSection;
  /** Machine-payment policies, reservations, and denial audit. Not part of PayRecord. */
  policies?: PolicyStoreSection;
};


const KV_KEY = PAY_STORE_KEY;

function completePair(urlName: string, tokenName: string): { url: string; token: string } | null {
  const url = process.env[urlName];
  const token = process.env[tokenName];
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

/**
 * Redis only when one provider pair is complete. A URL from one provider
 * is never paired with a token from the other. FINAL_PAY_STORE forces the
 * JSON file even if a Redis pair is present (local dev override).
 */
function kvCreds(): { url: string; token: string } | null {
  if (process.env.FINAL_PAY_STORE) return null;
  return (
    completePair("KV_REST_API_URL", "KV_REST_API_TOKEN") ??
    completePair("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN")
  );
}

/**
 * Which backend the pay store is using right now. Policy spend reservations use
 * this to pick an atomic ledger (Redis EVAL compare-and-set) or to refuse
 * spend-cap reservations on the JSON file. Credentials never leave the server.
 */
export function payStoreBackend(): { kind: "redis"; url: string; token: string } | { kind: "file"; path: string } {
  const kv = kvCreds();
  if (kv) return { kind: "redis", url: kv.url, token: kv.token };
  return { kind: "file", path: storePath() };
}

function storePath(): string {
  return process.env.FINAL_PAY_STORE || join(process.cwd(), "data", "pay-store.json");
}

function isStoreFile(value: unknown): value is StoreFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const records = (value as StoreFile).records;
  if (!records || typeof records !== "object" || Array.isArray(records)) return false;
  const webhooks = (value as StoreFile).webhooks;
  if (webhooks !== undefined && (!webhooks || typeof webhooks !== "object" || Array.isArray(webhooks))) return false;
  const apiKeys = (value as StoreFile).apiKeys;
  if (apiKeys !== undefined && (!apiKeys || typeof apiKeys !== "object" || Array.isArray(apiKeys))) return false;
  const escrows = (value as StoreFile).escrows;
  if (escrows !== undefined && (!escrows || typeof escrows !== "object" || Array.isArray(escrows))) return false;
  const agents = (value as StoreFile).agents;
  if (agents !== undefined) {
    if (!agents || typeof agents !== "object" || Array.isArray(agents)) return false;
    const intents = agents.intents;
    const idempotency = agents.idempotency;
    if (!intents || typeof intents !== "object" || Array.isArray(intents)) return false;
    if (!idempotency || typeof idempotency !== "object" || Array.isArray(idempotency)) return false;
  }
  const policies = (value as StoreFile).policies;
  if (policies !== undefined) {
    if (!policies || typeof policies !== "object" || Array.isArray(policies)) return false;
    if (!policies.records || typeof policies.records !== "object" || Array.isArray(policies.records)) return false;
    if (!policies.reservations || typeof policies.reservations !== "object" || Array.isArray(policies.reservations)) {
      return false;
    }
    if (!policies.denials || typeof policies.denials !== "object" || Array.isArray(policies.denials)) return false;
  }
  return true;
}

/** Payment writers that omit webhooks must not wipe a stored webhook section. */
function preserveWebhookSection(current: StoreFile, outgoing: StoreFile): void {
  if (outgoing.webhooks === undefined && current.webhooks !== undefined) {
    outgoing.webhooks = current.webhooks;
  }
}

/** Payment writers that omit apiKeys must not wipe stored API key hashes. */
function preserveApiKeySection(current: StoreFile, outgoing: StoreFile): void {
  if (outgoing.apiKeys === undefined && current.apiKeys !== undefined) {
    outgoing.apiKeys = current.apiKeys;
  }
}

/** Payment writers that omit escrows must not wipe escrow records. */
function preserveEscrowSection(current: StoreFile, outgoing: StoreFile): void {
  if (outgoing.escrows === undefined && current.escrows !== undefined) {
    outgoing.escrows = current.escrows;
  }
}

/** Payment writers that omit agents must not wipe intent or idempotency rows. */
function preserveAgentSection(current: StoreFile, outgoing: StoreFile): void {
  if (outgoing.agents === undefined && current.agents !== undefined) {
    outgoing.agents = current.agents;
  }
}

/** Payment writers that omit policies must not wipe policy, reservation, or denial rows. */
function preservePolicySection(current: StoreFile, outgoing: StoreFile): void {
  if (outgoing.policies === undefined && current.policies !== undefined) {
    outgoing.policies = current.policies;
  }
}

/**
 * Copy durable paid/cancelled flags from the snapshot the mutator started from.
 * With CAS retries, a concurrent paid/cancel that lands after this snapshot causes
 * a conflict and the mutator re-runs against the fresher blob.
 */
function preserveDurableFlags(current: StoreFile, outgoing: StoreFile): void {
  for (const [token, stored] of Object.entries(current.records)) {
    const next = outgoing.records[token];
    if (!next) {
      if (stored.paidTx || stored.cancelled) outgoing.records[token] = stored;
      continue;
    }
    if (stored.paidTx && !next.paidTx) next.paidTx = stored.paidTx;
    if (stored.cancelled && !next.cancelled) {
      next.cancelled = true;
      next.cancelledAt = stored.cancelledAt;
    }
  }
}

function applySectionGuards(current: StoreFile, outgoing: StoreFile): void {
  if (!outgoing.records || typeof outgoing.records !== "object" || Array.isArray(outgoing.records)) {
    outgoing.records = { ...current.records };
  }
  preserveDurableFlags(current, outgoing);
  preserveWebhookSection(current, outgoing);
  preserveApiKeySection(current, outgoing);
  preserveEscrowSection(current, outgoing);
  preserveAgentSection(current, outgoing);
  preservePolicySection(current, outgoing);
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // The status is enough. Never surface the body; it can echo the request.
  }
}

/**
 * Parse a Redis GET result into a store + the exact raw string used as the CAS token.
 * Missing key (null) → empty store with expectedRaw "". Malformed → fail closed (no wipe).
 */
function parseKvRaw(result: unknown): { store: StoreFile; raw: string } {
  if (result == null) return { store: { records: {} }, raw: "" };
  if (typeof result !== "string") throw new PayStoreMalformedError("Payment store read failed.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
    // Older writes used path-style SET with a JSON-string body and stored an
    // extra quoted layer. Unwrap one accidental string so those blobs still load.
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
  } catch {
    throw new PayStoreMalformedError("Payment store read failed.");
  }
  if (!isStoreFile(parsed)) throw new PayStoreMalformedError("Payment store read failed.");
  return { store: parsed, raw: result };
}

async function readKvRaw(creds: { url: string; token: string }): Promise<{ store: StoreFile; raw: string }> {
  let res: Response;
  try {
    res = await fetch(`${creds.url}/get/${KV_KEY}`, {
      headers: { Authorization: `Bearer ${creds.token}` },
      cache: "no-store",
    });
  } catch {
    throw new PayStoreUnavailableError("Payment store read failed.");
  }
  if (!res.ok) {
    await discardBody(res);
    throw new PayStoreUnavailableError(`Payment store read failed. HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new PayStoreUnavailableError("Payment store read failed.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || !("result" in body)) {
    throw new PayStoreUnavailableError("Payment store read failed.");
  }
  return parseKvRaw((body as { result?: unknown }).result);
}

async function casKv(creds: { url: string; token: string }, expectedRaw: string, nextRaw: string): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(creds.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["EVAL", PAY_STORE_CAS_SCRIPT, "1", KV_KEY, expectedRaw, nextRaw]),
    });
  } catch {
    throw new PayStoreUnavailableError("Payment store write failed.");
  }
  if (!res.ok) {
    await discardBody(res);
    throw new PayStoreUnavailableError(`Payment store write failed. HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new PayStoreUnavailableError("Payment store write failed.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || !("result" in body)) {
    throw new PayStoreUnavailableError("Payment store write failed.");
  }
  const result = (body as { result: unknown }).result;
  return result === 1 || result === "1";
}

/** Process-local serialization for the file backend. Not multi-instance safe. */
const fileTails = new Map<string, Promise<unknown>>();

function serializeFile<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = fileTails.get(path) ?? Promise.resolve();
  const run = previous.then(task, task);
  fileTails.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function readFileRaw(): Promise<{ store: StoreFile; raw: string }> {
  const path = storePath();
  try {
    const raw = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PayStoreMalformedError("Payment store read failed.");
    }
    if (!isStoreFile(parsed)) throw new PayStoreMalformedError("Payment store read failed.");
    return { store: parsed, raw };
  } catch (err) {
    if (err instanceof PayStoreMalformedError) throw err;
    if ((err as { code?: string }).code === "ENOENT") return { store: { records: {} }, raw: "" };
    // Legacy: a missing/unreadable local file is an empty store for first boot.
    // Any other I/O error fails closed rather than wiping Redis-shaped state.
    if (err instanceof SyntaxError) throw new PayStoreMalformedError("Payment store read failed.");
    throw new PayStoreUnavailableError("Payment store read failed.");
  }
}

async function casFile(expectedRaw: string, nextRaw: string): Promise<boolean> {
  const path = storePath();
  return serializeFile(path, async () => {
    let current = "";
    try {
      current = await readFile(path, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") {
        throw new PayStoreUnavailableError("Payment store write failed.");
      }
    }
    if (current !== expectedRaw) return false;
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, nextRaw, "utf8");
      await rename(tmp, path);
    } catch {
      try {
        await writeFile(path, nextRaw, "utf8");
      } catch {
        throw new PayStoreUnavailableError("Payment store write failed.");
      }
    }
    return true;
  });
}

async function readRaw(): Promise<{ store: StoreFile; raw: string }> {
  const kv = kvCreds();
  if (kv) return readKvRaw(kv);
  return readFileRaw();
}

async function casCommit(expectedRaw: string, nextRaw: string): Promise<boolean> {
  const kv = kvCreds();
  if (kv) return casKv(kv, expectedRaw, nextRaw);
  return casFile(expectedRaw, nextRaw);
}

async function readStore(): Promise<StoreFile> {
  const { store } = await readRaw();
  return store;
}

function cloneStore(store: StoreFile): StoreFile {
  return JSON.parse(JSON.stringify(store)) as StoreFile;
}

/**
 * Atomic read/modify/write for the shared pay-store blob (P1-02).
 *
 * Redis: Lua EVAL compare-and-set on the exact previous raw value.
 * File: process-local CAS only — not safe across multiple Node processes.
 *
 * The mutator must be pure (no external side effects). On conflict the latest
 * raw value is re-read and the mutator runs again (up to PAY_STORE_CAS_MAX_ATTEMPTS).
 * Exhaustion and backend failures fail closed — never an unconditional SET.
 */
export async function mutatePayStoreBlob(mutator: (store: StoreFile) => void): Promise<StoreFile> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PAY_STORE_CAS_MAX_ATTEMPTS; attempt += 1) {
    const { store, raw } = await readRaw();
    const next = cloneStore(store);
    mutator(next);
    applySectionGuards(store, next);
    const nextRaw = JSON.stringify(next);
    // Identical payload: nothing to write (avoids no-op CAS on missing-row reads).
    if (nextRaw === raw) return next;
    try {
      const ok = await casCommit(raw, nextRaw);
      if (ok) return next;
    } catch (err) {
      lastError = err;
      if (err instanceof PayStoreUnavailableError || err instanceof PayStoreMalformedError) throw err;
      throw err;
    }
  }
  if (lastError) throw lastError;
  throw new PayStoreCasExhaustedError();
}


export type PayPhase = "OPEN" | "VIEWED" | "PAID" | "CANCELLED" | "EXPIRED";

/**
 * EXPIRED is derived, never stored. There is no schema field for it.
 * An unpaid, uncancelled request whose clock is at or past expiresAt is
 * EXPIRED and must not be offered as payable.
 *
 * A settlement whose block time is strictly before expiresAt is still PAID
 * if it is applied later. That is an in-time payment discovered late, not
 * an expired request becoming payable. A settlement at or after expiresAt
 * is not a proof and cannot move the row to PAID.
 */
export function payPhase(row: PayRecord, nowSeconds: number, expiresAt: number | null): PayPhase {
  if (row.paidTx) return "PAID";
  if (row.cancelled) return "CANCELLED";
  if (expiresAt != null && nowSeconds >= expiresAt) return "EXPIRED";
  if (row.views > 0) return "VIEWED";
  return "OPEN";
}

/** True when a new payment must not be offered. Does not erase an in-time settlement. */
export function isDerivedExpired(nowSeconds: number, expiresAt: number | null): boolean {
  return expiresAt != null && nowSeconds >= expiresAt;
}

/**
 * Proof that verification already happened. This store does not read the chain.
 * V1 is the legacy hash the caller already matched. V2 must name the request
 * and carry a block time strictly before expiresAt. A bare transaction hash
 * is not a V2 proof.
 */
export type PaidProof =
  | { version: 1; tx: Hash }
  | {
      version: 2;
      tx: Hash;
      requestId: string;
      /** Unix seconds of the settlement block. Must be < expiresAt. */
      blockTimestamp: number;
      expiresAt: number;
    };

/** V1: the payee address is the only check. Not a signature. */
export type CancelCommand =
  | { version: 1; payee: Address }
  | {
      version: 2;
      requestId: string;
      nowSeconds: number;
      expiresAt: number;
    };

function sameId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** V2 request ids are 16 bytes. V1 link ids are not. */
function isV2RequestId(id: string): boolean {
  return /^0x[0-9a-fA-F]{32}$/.test(id);
}

/**
 * PAID and CANCELLED stay frozen. A later register cannot reopen them
 * or attach a payment to a cancelled row.
 */
export function mergePayRecord(existing: PayRecord | undefined, incoming: PayRecord): PayRecord {
  if (!existing) return incoming;
  if (existing.paidTx || existing.cancelled) {
    return {
      ...existing,
      webhookUrl: incoming.webhookUrl ?? existing.webhookUrl,
    };
  }
  return {
    ...existing,
    amount: incoming.amount,
    memo: incoming.memo,
    to: incoming.to,
    id: incoming.id,
    paidTx: null,
    webhookUrl: incoming.webhookUrl ?? existing.webhookUrl,
  };
}

/**
 * First valid settlement wins. A second hash, even a valid one, does not replace it.
 * CANCELLED and a V2 settlement at or after expiry do not become PAID.
 * V2 requires the verified request id. This function does not check signatures.
 */
export function nextPaidRecord(row: PayRecord, proof: PaidProof): PayRecord | null {
  if (row.paidTx) return row;
  if (row.cancelled) return null;
  if (proof.version === 2) {
    if (!isV2RequestId(row.id) || !sameId(row.id, proof.requestId)) return null;
    if (!Number.isSafeInteger(proof.blockTimestamp) || !Number.isSafeInteger(proof.expiresAt)) return null;
    if (proof.blockTimestamp < 0 || proof.expiresAt < 0) return null;
    if (proof.blockTimestamp >= proof.expiresAt) return null;
  } else if (isV2RequestId(row.id)) {
    return null;
  }
  return { ...row, paidTx: proof.tx };
}

/**
 * PAID cannot become CANCELLED. A derived-expired V2 request stays expired
 * instead of becoming CANCELLED. V1 has no expiry in this command.
 */
export function nextCancelledRecord(row: PayRecord, cancelledAt: string, command?: CancelCommand): PayRecord {
  if (row.paidTx || row.cancelled) return row;
  if (command?.version === 2 && command.nowSeconds >= command.expiresAt) return row;
  return { ...row, cancelled: true, cancelledAt };
}


export async function upsertRecord(record: PayRecord): Promise<PayRecord> {
  let saved: PayRecord = record;
  await mutatePayStoreBlob((store) => {
    const existing = store.records[record.token];
    saved = mergePayRecord(existing, record);
    store.records[record.token] = saved;
  });
  return saved;
}

/**
 * Create-or-merge a payment row with the per-merchant create cap evaluated
 * against the latest CAS snapshot. Updating an existing token does not consume
 * create capacity. Throws ResourceLimitExceededError when a new row would
 * exceed MAX_PAYMENT_RECORDS_PER_MERCHANT.
 */
export async function createPayRecord(
  record: PayRecord,
  owner: Address,
  opts?: { maxOwned?: number },
): Promise<{ record: PayRecord; created: boolean }> {
  const merchant = getAddress(owner);
  const limit = opts?.maxOwned ?? MAX_PAYMENT_RECORDS_PER_MERCHANT;
  let saved: PayRecord = record;
  let created = false;
  await mutatePayStoreBlob((store) => {
    const existing = store.records[record.token];
    if (existing) {
      saved = mergePayRecord(existing, record);
      store.records[record.token] = saved;
      created = false;
      return;
    }
    const owned = countPayRecordsOwnedBy(Object.values(store.records), merchant);
    if (owned >= limit) {
      throw new ResourceLimitExceededError("Payment request limit reached for this merchant.");
    }
    saved = record;
    store.records[record.token] = record;
    created = true;
  });
  return { record: saved, created };
}

export async function getRecord(token: string): Promise<PayRecord | null> {
  const store = await readStore();
  return store.records[token] ?? null;
}

export async function listByPayee(to: Address): Promise<PayRecord[]> {
  const store = await readStore();
  const needle = to.toLowerCase();
  return Object.values(store.records)
    .filter((row) => row.to.toLowerCase() === needle)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function markViewed(token: string): Promise<PayRecord | null> {
  let result: PayRecord | null = null;
  await mutatePayStoreBlob((store) => {
    const row = store.records[token];
    if (!row) {
      result = null;
      return;
    }
    row.views += 1;
    row.lastViewedAt = new Date().toISOString();
    result = row;
  });
  return result;
}

/**
 * V1 is legacy: command.payee must equal the stored recipient. That is not
 * merchant authentication. V2 requires the request id from a signature the
 * caller already checked. This function does not recover a signature.
 */
export async function markCancelled(token: string, command: CancelCommand): Promise<PayRecord | null> {
  let result: PayRecord | null = null;
  await mutatePayStoreBlob((store) => {
    const row = store.records[token];
    if (!row) {
      result = null;
      return;
    }
    if (command.version === 1) {
      if (row.to.toLowerCase() !== command.payee.toLowerCase()) {
        result = null;
        return;
      }
    } else if (!isV2RequestId(row.id) || !sameId(row.id, command.requestId)) {
      result = null;
      return;
    }
    const next = nextCancelledRecord(row, new Date().toISOString(), command);
    if (next === row) {
      result = row;
      return;
    }
    store.records[token] = next;
    result = next;
  });
  return result;
}

/** Refuses a V2 hash that did not come with the verified request identity. Persistence only — does not change reconciliation. */
export async function markPaid(token: string, proof: PaidProof): Promise<PayRecord | null> {
  let result: PayRecord | null = null;
  await mutatePayStoreBlob((store) => {
    const row = store.records[token];
    if (!row) {
      result = null;
      return;
    }
    const next = nextPaidRecord(row, proof);
    if (!next) {
      result = null;
      return;
    }
    if (next === row) {
      result = row;
      return;
    }
    store.records[token] = next;
    result = next;
  });
  return result;
}

/**
 * Every row in the existing blob. Lookup is O(n). This does not add a key,
 * a second store, or a public list of merchants.
 */
export async function listRecords(): Promise<PayRecord[]> {
  const store = await readStore();
  return Object.values(store.records);
}

/**
 * Full blob for webhook infrastructure and other section readers.
 * Callers must not put webhook secrets on PayRecord or return this blob from /api/pay.
 */
export async function readPayStoreBlob(): Promise<StoreFile> {
  return readStore();
}

/**
 * @deprecated Prefer mutatePayStoreBlob. Full-blob replacement from a caller-held
 * snapshot is unsafe under concurrency. Kept only so test doubles that still
 * inject writeBlob can be migrated; live paths must not use this for Redis writes.
 *
 * Implementation: CAS-mutates by copying each provided section onto a fresh clone.
 * Concurrent updates to keys the caller omitted inside a section can still be lost
 * if the caller passed a stale section map — callers should use mutatePayStoreBlob.
 */
export async function writePayStoreBlob(store: StoreFile): Promise<void> {
  await mutatePayStoreBlob((current) => {
    current.records = store.records;
    if (store.webhooks !== undefined) current.webhooks = store.webhooks;
    if (store.apiKeys !== undefined) current.apiKeys = store.apiKeys;
    if (store.escrows !== undefined) current.escrows = store.escrows;
    if (store.agents !== undefined) current.agents = store.agents;
    if (store.policies !== undefined) current.policies = store.policies;
  });
}
