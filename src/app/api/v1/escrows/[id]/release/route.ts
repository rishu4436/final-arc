import { releaseEscrow, liveEscrowDeps } from "@/lib/escrowService";
import { NextResponse } from "next/server";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const result = await releaseEscrow(request, id, liveEscrowDeps());
  return NextResponse.json(result.body, { status: result.status });
}
