import { NextResponse } from "next/server";
import { loadReceipt } from "@/lib/loadReceipt";

export async function GET(
  _request: Request,
  context: { params: Promise<{ hash: string }> },
) {
  const { hash } = await context.params;
  const result = await loadReceipt(hash);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result);
}
