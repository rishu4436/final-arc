import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { decideCancellation } from "@/lib/finalCancel";
import { findSettlementProof, lookupFromRecord, payRecordIdentity, type PayIdentity } from "@/lib/payPaid";
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

function blankRecord(token: string, identity: PayIdentity, webhookUrl: string | null): PayRecord {
  return {
    token,
    id: identity.id,
    to: identity.to,
    amount: identity.amount,
    memo: identity.memo,
    createdAt: new Date().toISOString(),
    views: 0,
    lastViewedAt: null,
    cancelled: false,
    cancelledAt: null,
    paidTx: null,
    webhookUrl,
  };
}

async function withPaid(row: PayRecord): Promise<PayRecord> {
  if (row.paidTx || row.cancelled) return row;
  const lookup = lookupFromRecord(row);
  // Invalid V2 links do not fall back to recipient + amount + memo.
  if (!lookup) return row;
  try {
    const proof = await findSettlementProof(lookup);
    if (!proof) return row;
    const updated = await markPaid(row.token, proof);
    if (!updated || updated.paidTx !== proof.tx) return updated ?? row;
    void notifyWebhook(updated, "paid");
    return updated;
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
      const identity = payRecordIdentity(token);
      if (!identity) return NextResponse.json({ error: "Unknown payment." }, { status: 404 });
      row = await upsertRecord(blankRecord(token, identity, null));
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
    /** V2 merchant EIP-712 CancelPaymentRequest signature. Ignored for V1. */
    signature?: string;
    webhookUrl?: string;
  };
  const token = tokenFrom(body);
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });
  const identity = payRecordIdentity(token);
  if (!identity) return NextResponse.json({ error: "Invalid payment link." }, { status: 400 });

  const action = body.action ?? "register";

  if (action === "register") {
    const webhookUrl =
      typeof body.webhookUrl === "string" && /^https:\/\//i.test(body.webhookUrl)
        ? body.webhookUrl
        : null;
    const row = await upsertRecord(blankRecord(token, identity, webhookUrl));
    return NextResponse.json({ record: await withPaid(row) });
  }

  if (action === "view") {
    let row = await getRecord(token);
    if (!row) {
      row = await upsertRecord(blankRecord(token, identity, null));
    }
    row = (await markViewed(token)) ?? row;
    const next = await withPaid(row);
    if (!next.paidTx) void notifyWebhook(next, "viewed");
    return NextResponse.json({ record: next });
  }

  if (action === "cancel") {
    const lookup = lookupFromRecord({
      token,
      to: identity.to,
      amount: identity.amount,
      memo: identity.memo,
      cancelled: false,
    });
    const decision = await decideCancellation({
      version: identity.version,
      payee: identity.to,
      request: lookup && lookup.version === 2 ? lookup.request : undefined,
      address: body.address,
      signature: body.signature,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!decision.ok) {
      return NextResponse.json({ error: decision.error }, { status: decision.status });
    }
    const row = await markCancelled(
      token,
      decision.version === 1
        ? { version: 1, payee: decision.payee }
        : {
            version: 2,
            requestId: decision.requestId,
            nowSeconds: decision.nowSeconds,
            expiresAt: decision.expiresAt,
          },
    );
    if (!row) {
      return NextResponse.json(
        {
          error:
            decision.version === 2
              ? "Only the merchant can cancel this request."
              : "Only the payee can cancel this link.",
        },
        { status: 403 },
      );
    }
    if (row.paidTx) {
      return NextResponse.json({ record: row });
    }
    const next = await withPaid(row);
    void notifyWebhook(next, "cancelled");
    return NextResponse.json({ record: next });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
