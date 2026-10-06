import { NextResponse } from "next/server";
import type { SessionHttpResult } from "@/lib/workspaceSession";

/** JSON response for workspace session routes. Never cached; Set-Cookie when provided. */
export function sessionResponse(result: SessionHttpResult): NextResponse {
  const response = NextResponse.json(result.body, { status: result.status });
  response.headers.set("Cache-Control", "no-store");
  if (result.setCookie) response.headers.append("Set-Cookie", result.setCookie);
  return response;
}
