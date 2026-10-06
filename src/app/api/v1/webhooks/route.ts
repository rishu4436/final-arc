import { authorizeHttp, parseJsonObject, readRequestBodyText } from "@/lib/apiKeys";
import { WALLET_ACTIONS } from "@/lib/apiScopes";
import { createWebhookEndpoint, defaultWebhookDeps, listWebhookEndpoints, type WebhookDeps } from "@/lib/webhooks";
import { NextResponse } from "next/server";

function depsFor(merchant: `0x${string}`): WebhookDeps {
  return { ...defaultWebhookDeps(), caller: merchant };
}

export async function GET(request: Request) {
  const auth = await authorizeHttp(request, {
    scope: "webhooks:read",
    walletAction: WALLET_ACTIONS.webhooksList,
    bodyText: "",
  });
  if (!("merchant" in auth)) return NextResponse.json(auth.body, { status: auth.status });
  const result = await listWebhookEndpoints(auth.merchant, depsFor(auth.merchant));
  return NextResponse.json(result.body, { status: result.status });
}

export async function POST(request: Request) {
  const bodyText = await readRequestBodyText(request);
  const auth = await authorizeHttp(request, {
    scope: "webhooks:write",
    walletAction: WALLET_ACTIONS.webhooksCreate,
    bodyText,
  });
  if (!("merchant" in auth)) return NextResponse.json(auth.body, { status: auth.status });
  const parsed = parseJsonObject(bodyText);
  if ("status" in parsed) {
    const err = parsed as { status: number; body: unknown };
    return NextResponse.json(err.body, { status: err.status });
  }
  const input = parsed;
  const result = await createWebhookEndpoint(
    {
      merchant: input.merchant === undefined ? auth.merchant : input.merchant,
      url: input.url,
      events: input.events,
      enabled: input.enabled,
    },
    depsFor(auth.merchant),
  );
  return NextResponse.json(result.body, { status: result.status });
}
