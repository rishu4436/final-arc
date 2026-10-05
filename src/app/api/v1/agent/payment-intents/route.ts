import { createAgentPaymentIntent, liveAgentPaymentsDeps } from "@/lib/agentPayments";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const result = await createAgentPaymentIntent(request, liveAgentPaymentsDeps(request.headers.get("authorization")));
  return NextResponse.json(result.body, { status: result.status });
}
