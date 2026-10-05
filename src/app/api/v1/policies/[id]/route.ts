import { deletePolicy, getPolicy, livePolicyDeps, updatePolicy } from "@/lib/paymentPolicies";
import { NextResponse } from "next/server";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const result = await getPolicy(request, id, livePolicyDeps());
  return NextResponse.json(result.body, { status: result.status });
}

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  const result = await updatePolicy(request, id, livePolicyDeps());
  return NextResponse.json(result.body, { status: result.status });
}

export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  const result = await deletePolicy(request, id, livePolicyDeps());
  return NextResponse.json(result.body, { status: result.status });
}
