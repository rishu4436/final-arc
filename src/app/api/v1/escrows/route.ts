import { createEscrow, listEscrows, liveEscrowDeps } from "@/lib/escrowService";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const result = await createEscrow(request, liveEscrowDeps());
  return NextResponse.json(result.body, { status: result.status });
}

export async function GET(request: Request) {
  const result = await listEscrows(request, liveEscrowDeps());
  return NextResponse.json(result.body, { status: result.status });
}
