import { authorizeHttp } from "@/lib/apiKeys";
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
  });
  if (!("merchant" in auth)) return NextResponse.json(auth.body, { status: auth.status });
  const result = await listWebhookEndpoints(auth.merchant, depsFor(auth.merchant));
  return NextResponse.json(result.body, { status: result.status });
}

export async function POST(request: Request) {
  const auth = await authorizeHttp(request, {
    scope: "webhooks:write",
    walletAction: WALLET_ACTIONS.webhooksCreate,
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
