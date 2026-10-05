import { createPaymentRequest, liveDeveloperApiDeps } from "@/lib/developerApi";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const result = await createPaymentRequest(
    request,
    liveDeveloperApiDeps(request.headers.get("authorization")),
  );
  return NextResponse.json(result.body, { status: result.status });
}
