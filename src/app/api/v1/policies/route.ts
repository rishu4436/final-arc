import { createPolicy, listPolicies, livePolicyDeps } from "@/lib/paymentPolicies";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const result = await listPolicies(request, livePolicyDeps());
  return NextResponse.json(result.body, { status: result.status });
}

export async function POST(request: Request) {
  const result = await createPolicy(request, livePolicyDeps());
  return NextResponse.json(result.body, { status: result.status });
}
