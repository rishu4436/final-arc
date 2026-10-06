import { authorizeHttp } from "@/lib/apiKeys";
import { WALLET_ACTIONS } from "@/lib/apiScopes";
import { defaultWebhookDeps, listWebhookDeliveries } from "@/lib/webhooks";
import { NextResponse } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = await authorizeHttp(request, {
    scope: "webhooks:read",
    walletAction: WALLET_ACTIONS.webhooksDeliveries,
    bodyText: "",
  });
  if (!("merchant" in auth)) return NextResponse.json(auth.body, { status: auth.status });
  const result = await listWebhookDeliveries(id, auth.merchant, {
    ...defaultWebhookDeps(),
    caller: auth.merchant,
  });
  return NextResponse.json(result.body, { status: result.status });
}
