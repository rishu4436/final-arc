import { authorizeHttp } from "@/lib/apiKeys";
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
  });
  if (!("merchant" in auth)) return NextResponse.json(auth.body, { status: auth.status });
  const result = await getWebhookEndpoint(id, auth.merchant, depsFor(auth.merchant));
  return NextResponse.json(result.body, { status: result.status });
}

export async function PATCH(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = await authorizeHttp(request, {
    scope: "webhooks:write",
    walletAction: WALLET_ACTIONS.webhooksUpdate,
  });
  if (!("merchant" in auth)) return NextResponse.json(auth.body, { status: auth.status });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_json", message: "Request body must be JSON." } },
      { status: 400 },
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: { code: "invalid_json", message: "Request body must be a JSON object." } },
      { status: 400 },
    );
  }
  const input = body as Record<string, unknown>;
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
  });
  if (!("merchant" in auth)) return NextResponse.json(auth.body, { status: auth.status });
  const result = await deleteWebhookEndpoint(id, auth.merchant, depsFor(auth.merchant));
  return NextResponse.json(result.body, { status: result.status });
}
