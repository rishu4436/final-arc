import { handleDeleteApiKey, handleGetApiKey, handleUpdateApiKey } from "@/lib/apiKeys";
import { NextResponse } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const result = await handleGetApiKey(request, id);
  return NextResponse.json(result.body, { status: result.status });
}

export async function PATCH(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const result = await handleUpdateApiKey(request, id);
  return NextResponse.json(result.body, { status: result.status });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const result = await handleDeleteApiKey(request, id);
  return NextResponse.json(result.body, { status: result.status });
}
