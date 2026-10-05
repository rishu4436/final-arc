import { analyticsPolicies, liveAnalyticsDeps } from "@/lib/analyticsHttp";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Read-only. Requires analytics:read (API key) or the analytics.read wallet action. */
export async function GET(request: Request) {
  const result = await analyticsPolicies(request, liveAnalyticsDeps());
  return NextResponse.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
}
