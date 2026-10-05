import { liveAgentPaymentsDeps, submitAgentPaymentIntent } from "@/lib/agentPayments";
import { NextResponse } from "next/server";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const result = await submitAgentPaymentIntent(
    request,
    id,
    liveAgentPaymentsDeps(request.headers.get("authorization")),
  );
  return NextResponse.json(result.body, { status: result.status });
}
