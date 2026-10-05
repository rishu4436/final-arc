import { handleRotateApiKey } from "@/lib/apiKeys";
import { NextResponse } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const result = await handleRotateApiKey(request, id);
  return NextResponse.json(result.body, { status: result.status });
}
