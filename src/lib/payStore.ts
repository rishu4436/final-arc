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
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

function storePath(): string {
  return join(process.cwd(), "data", "pay-store.json");
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

export async function upsertRecord(record: PayRecord): Promise<PayRecord> {
  const store = await readStore();
  const existing = store.records[record.token];
  store.records[record.token] = existing
    ? {
        ...existing,
        amount: record.amount,
        memo: record.memo,
        to: record.to,
        id: record.id,
        paidTx: existing.paidTx ?? record.paidTx,
        webhookUrl: record.webhookUrl ?? existing.webhookUrl,
      }
    : record;
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

export async function markCancelled(token: string, to: Address): Promise<PayRecord | null> {
  const store = await readStore();
  const row = store.records[token];
  if (!row) return null;
  if (row.to.toLowerCase() !== to.toLowerCase()) return null;
  row.cancelled = true;
  row.cancelledAt = new Date().toISOString();
  await writeStore(store);
  return row;
}

export async function markPaid(token: string, tx: Hash): Promise<PayRecord | null> {
  const store = await readStore();
  const row = store.records[token];
  if (!row) return null;
  row.paidTx = tx;
  await writeStore(store);
  return row;
}
