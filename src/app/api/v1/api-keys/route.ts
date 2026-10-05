import { handleCreateApiKey, handleListApiKeys } from "@/lib/apiKeys";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const result = await handleListApiKeys(request);
  return NextResponse.json(result.body, { status: result.status });
}

export async function POST(request: Request) {
  const result = await handleCreateApiKey(request);
  return NextResponse.json(result.body, { status: result.status });
}
