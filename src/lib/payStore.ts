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
};

type StoreFile = { records: Record<string, PayRecord> };

function storePath(): string {
  if (process.env.VERCEL) return join("/tmp", "final-pay-store.json");
  return join(process.cwd(), "data", "pay-store.json");
}

async function readStore(): Promise<StoreFile> {
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
