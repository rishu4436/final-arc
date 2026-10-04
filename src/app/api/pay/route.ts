import { NextResponse } from "next/server";
import { livePayStatusDeps, payGet, payPost } from "@/lib/payStatusHttp";

export async function GET(request: Request) {
  const result = await payGet(request, livePayStatusDeps);
  return NextResponse.json(result.body, { status: result.status });
}

export async function POST(request: Request) {
  const result = await payPost(request, livePayStatusDeps);
  return NextResponse.json(result.body, { status: result.status });
}
