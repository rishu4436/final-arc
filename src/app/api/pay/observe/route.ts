import { observeCheckoutRecord } from "@/lib/checkoutObserve";
import { getRecord } from "@/lib/payStore";
import { NextResponse } from "next/server";

/**
 * Read-only checkout status. GET /api/pay?token= still reconciles for other
 * callers. This route only reads the stored row for the payment-link token.
 * It does not reconcile, mark paid, register, or emit webhooks.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const result = await observeCheckoutRecord(token, { getRecord });
  return NextResponse.json(result.body, { status: result.status });
}
