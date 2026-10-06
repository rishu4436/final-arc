import { verifyArcTransaction } from "@/lib/arcProof";
import { RATE_LIMITED_MESSAGE, legacyAllow, requestClientKey } from "@/lib/publicRateLimit";
import { NextResponse } from "next/server";

/**
 * Read-only transaction proof. Does not read or write payment records.
 *
 * Phase 13 (P1-05): intentionally public. The body is global Arc chain data
 * (transaction, Memo, USDC transfer, certificate) from verifyArcTransaction. It
 * contains no payment-request row, merchant workspace field, webhook URL, or
 * view count. Each call costs Arc RPC, so it is rate limited per client IP,
 * per process and through the shared Redis counter (see publicRateLimit.ts).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ hash: string }> },
) {
  if (!(await legacyAllow("receipt.proof", requestClientKey(request)))) {
    return NextResponse.json({ error: RATE_LIMITED_MESSAGE, code: "rate_limited" }, { status: 429 });
  }
  const { hash } = await context.params;
  const result = await verifyArcTransaction(hash);
  if (result.status === "INVALID_FORMAT") {
    return NextResponse.json({ error: "Invalid transaction hash.", status: result.status }, { status: 400 });
  }
  if (result.status === "NOT_FOUND") {
    return NextResponse.json(
      { error: "Transaction not found on Arc mainnet.", status: result.status },
      { status: 404 },
    );
  }
  if (result.status === "UNAVAILABLE") {
    return NextResponse.json(
      { error: "Arc transaction data is unavailable.", status: result.status },
      { status: 503 },
    );
  }
  return NextResponse.json(result);
}
