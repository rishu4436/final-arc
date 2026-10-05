import { liveDeveloperApiDeps, verifyTransaction } from "@/lib/developerApi";
import { NextResponse } from "next/server";

export async function GET(request: Request, context: { params: Promise<{ tx: string }> }) {
  const { tx } = await context.params;
  const result = await verifyTransaction(tx, liveDeveloperApiDeps(request.headers.get("authorization")));
  return NextResponse.json(result.body, { status: result.status });
}
