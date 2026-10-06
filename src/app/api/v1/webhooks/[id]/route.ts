import { authorizeHttp, parseJsonObject, readRequestBodyText } from "@/lib/apiKeys";
import { WALLET_ACTIONS } from "@/lib/apiScopes";
import {
  defaultWebhookDeps,
  deleteWebhookEndpoint,
  getWebhookEndpoint,
  updateWebhookEndpoint,
  type WebhookDeps,
} from "@/lib/webhooks";
import { NextResponse } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

function depsFor(merchant: `0x${string}`): WebhookDeps {
  return { ...defaultWebhookDeps(), caller: merchant };
}

export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = await authorizeHttp(request, {
    scope: "webhooks:read",
    walletAction: WALLET_ACTIONS.webhooksGet,
    bodyText: "",
  });
  if (!("merchant" in auth)) return NextResponse.json(auth.body, { status: auth.status });
  const result = await getWebhookEndpoint(id, auth.merchant, depsFor(auth.merchant));
  return NextResponse.json(result.body, { status: result.status });
}

export async function PATCH(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const bodyText = await readRequestBodyText(request);
  const auth = await authorizeHttp(request, {
    scope: "webhooks:write",
    walletAction: WALLET_ACTIONS.webhooksUpdate,
    bodyText,
  });
  if (!("merchant" in auth)) return NextResponse.json(auth.body, { status: auth.status });
  const parsed = parseJsonObject(bodyText);
  if ("status" in parsed) {
    const err = parsed as { status: number; body: unknown };
    return NextResponse.json(err.body, { status: err.status });
  }
  const input = parsed;
  const result = await updateWebhookEndpoint(
    id,
    {
      merchant: input.merchant === undefined ? auth.merchant : input.merchant,
      url: input.url,
      events: input.events,
      enabled: input.enabled,
      rotateSecret: input.rotateSecret,
    },
    depsFor(auth.merchant),
  );
  return NextResponse.json(result.body, { status: result.status });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = await authorizeHttp(request, {
    scope: "webhooks:write",
    walletAction: WALLET_ACTIONS.webhooksDelete,
    bodyText: "",
  });
  if (!("merchant" in auth)) return NextResponse.json(auth.body, { status: auth.status });
  const result = await deleteWebhookEndpoint(id, auth.merchant, depsFor(auth.merchant));
  return NextResponse.json(result.body, { status: result.status });
}
