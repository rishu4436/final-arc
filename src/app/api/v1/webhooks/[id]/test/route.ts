import { authorizeHttp } from "@/lib/apiKeys";
import { WALLET_ACTIONS } from "@/lib/apiScopes";
import { defaultWebhookDeps, sendWebhookTest } from "@/lib/webhooks";
import { NextResponse } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = await authorizeHttp(request, {
    scope: "webhooks:write",
    walletAction: WALLET_ACTIONS.webhooksTest,
  });
  if (!("merchant" in auth)) return NextResponse.json(auth.body, { status: auth.status });
  const result = await sendWebhookTest(id, auth.merchant, {
    ...defaultWebhookDeps(),
    caller: auth.merchant,
  });
  return NextResponse.json(result.body, { status: result.status });
}
