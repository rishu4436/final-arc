import { getEscrow, liveEscrowDeps } from "@/lib/escrowService";
import { NextResponse } from "next/server";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const result = await getEscrow(request, id, liveEscrowDeps());
  return NextResponse.json(result.body, { status: result.status });
}
