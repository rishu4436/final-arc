import { NextResponse } from "next/server";
import { livePayStatusDeps, statementGet } from "@/lib/payStatusHttp";

export async function GET(request: Request) {
  const result = await statementGet(request, livePayStatusDeps);
  return NextResponse.json(result.body, { status: result.status });
}
