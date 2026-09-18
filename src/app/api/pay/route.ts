import { NextResponse } from "next/server";
import { getAddress, isAddress, type Address } from "viem";
import { decodePayRequest } from "@/lib/payRequest";
import { findPaidTx } from "@/lib/payPaid";
import { notifyWebhook } from "@/lib/notify";
import {
  getRecord,
  listByPayee,
  markCancelled,
  markPaid,
  markViewed,
  upsertRecord,
  type PayRecord,
} from "@/lib/payStore";

function tokenFrom(body: { token?: string } | null): string | null {
  const token = body?.token?.trim();
  return token || null;
}

async function withPaid(row: PayRecord): Promise<PayRecord> {
  if (row.paidTx) return row;
  try {
    const tx = await findPaidTx({ to: row.to, amount: row.amount, memo: row.memo });
    if (tx) {
      const updated = await markPaid(row.token, tx);
      const next = updated ?? { ...row, paidTx: tx };
      void notifyWebhook(next, "paid");
      return next;
    }
  } catch {
    /* RPC lookup is best-effort */
  }
  return row;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const to = url.searchParams.get("to");

  if (token) {
    let row = await getRecord(token);
    if (!row) {
      const req = decodePayRequest(token);
      if (!req) return NextResponse.json({ error: "Unknown payment." }, { status: 404 });
      row = await upsertRecord({
        token,
        id: req.id,
        to: req.to,
        amount: req.amount,
        memo: req.memo,
        createdAt: new Date().toISOString(),
        views: 0,
        lastViewedAt: null,
        cancelled: false,
        cancelledAt: null,
        paidTx: null,
        webhookUrl: null,
      });
    }
    row = await withPaid(row);
    return NextResponse.json({ record: row });
  }

  if (to && isAddress(to)) {
    const rows = await listByPayee(getAddress(to));
    const records = await Promise.all(rows.map((row) => withPaid(row)));
    return NextResponse.json({ records });
  }

  return NextResponse.json({ error: "token or to required" }, { status: 400 });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    token?: string;
    action?: "register" | "view" | "cancel";
    address?: string;
    webhookUrl?: string;
  };
  const token = tokenFrom(body);
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });
  const req = decodePayRequest(token);
  if (!req) return NextResponse.json({ error: "Invalid payment link." }, { status: 400 });

  const action = body.action ?? "register";

  if (action === "register") {
    const webhookUrl =
      typeof body.webhookUrl === "string" && /^https:\/\//i.test(body.webhookUrl)
        ? body.webhookUrl
        : null;
    const row = await upsertRecord({
      token,
      id: req.id,
      to: req.to,
      amount: req.amount,
      memo: req.memo,
      createdAt: new Date().toISOString(),
      views: 0,
      lastViewedAt: null,
      cancelled: false,
      cancelledAt: null,
      paidTx: null,
      webhookUrl,
    });
    return NextResponse.json({ record: await withPaid(row) });
  }

  if (action === "view") {
    let row = await getRecord(token);
    if (!row) {
      row = await upsertRecord({
        token,
        id: req.id,
        to: req.to,
        amount: req.amount,
        memo: req.memo,
        createdAt: new Date().toISOString(),
        views: 0,
        lastViewedAt: null,
        cancelled: false,
        cancelledAt: null,
        paidTx: null,
        webhookUrl: null,
      });
    }
    row = (await markViewed(token)) ?? row;
    const next = await withPaid(row);
    if (!next.paidTx) void notifyWebhook(next, "viewed");
    return NextResponse.json({ record: next });
  }

  if (action === "cancel") {
    if (!body.address || !isAddress(body.address)) {
      return NextResponse.json({ error: "Connect the payee wallet to cancel." }, { status: 401 });
    }
    const row = await markCancelled(token, getAddress(body.address) as Address);
    if (!row) {
      return NextResponse.json({ error: "Only the payee can cancel this link." }, { status: 403 });
    }
    const next = await withPaid(row);
    void notifyWebhook(next, "cancelled");
    return NextResponse.json({ record: next });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

