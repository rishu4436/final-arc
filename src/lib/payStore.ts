import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Address, Hash } from "viem";

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

const KV_KEY = "final-pay-store";

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

/** Missing key (result null) is an empty store. Anything else malformed is a failure. */
function parseKvResult(result: unknown): StoreFile {
  if (result == null) return { records: {} };
  if (typeof result !== "string") throw new Error("Payment store read failed.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    throw new Error("Payment store read failed.");
  }
  if (!isStoreFile(parsed)) throw new Error("Payment store read failed.");
  return parsed;
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // The status is enough. Never surface the body; it can echo the request.
  }
}

async function readKv(creds: { url: string; token: string }): Promise<StoreFile> {
  let res: Response;
  try {
    res = await fetch(`${creds.url}/get/${KV_KEY}`, {
      headers: { Authorization: `Bearer ${creds.token}` },
      cache: "no-store",
    });
  } catch {
    throw new Error("Payment store read failed.");
  }
  if (!res.ok) {
    await discardBody(res);
    throw new Error(`Payment store read failed. HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("Payment store read failed.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || !("result" in body)) {
    throw new Error("Payment store read failed.");
  }
  return parseKvResult((body as { result?: unknown }).result);
}

async function writeKv(creds: { url: string; token: string }, store: StoreFile): Promise<void> {
  const value = JSON.stringify(store);
  let res: Response;
  try {
    res = await fetch(`${creds.url}/set/${KV_KEY}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    });
  } catch {
    throw new Error("Payment store write failed.");
  }
  if (!res.ok) {
    await discardBody(res);
    throw new Error(`Payment store write failed. HTTP ${res.status}`);
  }
  await discardBody(res);
}

async function readFileStore(): Promise<StoreFile> {
  try {
    const raw = await readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    if (!parsed.records) return { records: {} };
    return parsed;
  } catch {
    return { records: {} };
  }
}

async function readStore(): Promise<StoreFile> {
  const kv = kvCreds();
  if (kv) return readKv(kv);
  return readFileStore();
}

/**
 * Copy a stored paidTx or cancelled flag back onto the outgoing blob when
 * the outgoing row would clear it, including when the outgoing blob dropped
 * the row. Check-then-write, not compare-and-set: the Redis REST GET/SET
 * interface has no conditional write, and this re-read is not atomic with
 * the SET. A paidTx or cancellation that lands after this re-read can still
 * be overwritten. Two overlapping writers can still lose unpaid field
 * updates. A non-null paidTx can still be replaced by a different hash.
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

async function writeStore(store: StoreFile): Promise<void> {
  const current = await readStore();
  preserveDurableFlags(current, store);
  preserveWebhookSection(current, store);
  preserveApiKeySection(current, store);
  preserveEscrowSection(current, store);
  preserveAgentSection(current, store);
  preservePolicySection(current, store);
  const kv = kvCreds();
  if (kv) {
    await writeKv(kv, store);
    return;
  }
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store), "utf8");
}

/**
 * Whole-store read/modify/write (one JSON blob, or one Redis key).
 * Two writers can both read the same snapshot and the later write wins.
 * That race is not atomic. These helpers only define the single-writer
 * transition. They do not claim compare-and-swap. writeStore re-reads and
 * refuses to clear paidTx or cancelled, but that check is not atomic either.
 */
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
  const store = await readStore();
  const existing = store.records[record.token];
  store.records[record.token] = mergePayRecord(existing, record);
  await writeStore(store);
  return store.records[record.token];
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
  const store = await readStore();
  const row = store.records[token];
  if (!row) return null;
  row.views += 1;
  row.lastViewedAt = new Date().toISOString();
  await writeStore(store);
  return row;
}

/**
 * V1 is legacy: command.payee must equal the stored recipient. That is not
 * merchant authentication. V2 requires the request id from a signature the
 * caller already checked. This function does not recover a signature.
 */
export async function markCancelled(token: string, command: CancelCommand): Promise<PayRecord | null> {
  const store = await readStore();
  const row = store.records[token];
  if (!row) return null;
  if (command.version === 1) {
    if (row.to.toLowerCase() !== command.payee.toLowerCase()) return null;
  } else if (!isV2RequestId(row.id) || !sameId(row.id, command.requestId)) {
    return null;
  }
  const next = nextCancelledRecord(row, new Date().toISOString(), command);
  if (next === row) return row;
  store.records[token] = next;
  await writeStore(store);
  return next;
}

/** Refuses a V2 hash that did not come with the verified request identity. */
export async function markPaid(token: string, proof: PaidProof): Promise<PayRecord | null> {
  const store = await readStore();
  const row = store.records[token];
  if (!row) return null;
  const next = nextPaidRecord(row, proof);
  if (!next) return null;
  if (next === row) return row;
  store.records[token] = next;
  await writeStore(store);
  return next;
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
 * Full blob for webhook infrastructure. Payment helpers keep using readStore/writeStore.
 * Callers must not put webhook secrets on PayRecord or return this blob from /api/pay.
 */
export async function readPayStoreBlob(): Promise<StoreFile> {
  return readStore();
}

export async function writePayStoreBlob(store: StoreFile): Promise<void> {
  await writeStore(store);
}

export async function mutatePayStoreBlob(mutator: (store: StoreFile) => void): Promise<StoreFile> {
  const store = await readStore();
  mutator(store);
  await writeStore(store);
  return store;
}
