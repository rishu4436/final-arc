import { getPaymentReceipt, liveDeveloperApiDeps } from "@/lib/developerApi";
import { NextResponse } from "next/server";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await getPaymentReceipt(id, liveDeveloperApiDeps(request.headers.get("authorization")));
  return NextResponse.json(result.body, { status: result.status });
}
