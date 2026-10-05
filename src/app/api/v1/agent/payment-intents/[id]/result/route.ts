import { getAgentPaymentResult, liveAgentPaymentsDeps } from "@/lib/agentPayments";
import { NextResponse } from "next/server";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const result = await getAgentPaymentResult(request, id, liveAgentPaymentsDeps(request.headers.get("authorization")));
  return NextResponse.json(result.body, { status: result.status });
}
