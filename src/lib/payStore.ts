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

type StoreFile = { records: Record<string, PayRecord> };

const KV_KEY = "final-pay-store";

function kvCreds(): { url: string; token: string } | null {
  if (process.env.FINAL_PAY_STORE) return null;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

function storePath(): string {
  return process.env.FINAL_PAY_STORE || join(process.cwd(), "data", "pay-store.json");
}

async function readKv(creds: { url: string; token: string }): Promise<StoreFile | null> {
  const res = await fetch(`${creds.url}/get/${KV_KEY}`, {
    headers: { Authorization: `Bearer ${creds.token}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { result?: string | null };
  if (!body.result) return { records: {} };
  try {
    const parsed = JSON.parse(body.result) as StoreFile;
    return parsed.records ? parsed : { records: {} };
  } catch {
    return { records: {} };
  }
}

async function writeKv(creds: { url: string; token: string }, store: StoreFile): Promise<void> {
  const value = JSON.stringify(store);
  await fetch(`${creds.url}/set/${KV_KEY}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });
}

async function readStore(): Promise<StoreFile> {
  const kv = kvCreds();
  if (kv) {
    const fromKv = await readKv(kv);
    if (fromKv) return fromKv;
  }
  try {
    const raw = await readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    if (!parsed.records) return { records: {} };
    return parsed;
  } catch {
    return { records: {} };
  }
}

async function writeStore(store: StoreFile): Promise<void> {
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
 * transition. They do not claim compare-and-swap.
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
