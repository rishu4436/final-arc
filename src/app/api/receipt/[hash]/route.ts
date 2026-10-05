import { verifyArcTransaction } from "@/lib/arcProof";
import { NextResponse } from "next/server";

/** Read-only transaction proof. Does not read or write payment records. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ hash: string }> },
) {
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
