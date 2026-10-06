import {
  authorizeWebhookCron,
  defaultWebhookDeps,
  processDueWebhookDeliveries,
  toPublicDelivery,
} from "@/lib/webhooks";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Protected webhook delivery processor.
 * Auth: Authorization Bearer CRON_SECRET only (fail-closed when unset).
 * Merchant API keys are never accepted.
 *
 * Production scheduling requires CRON_SECRET plus a supported Vercel Cron plan.
 * Hobby minute crons are not available; do not treat a successful deploy as proof
 * that automatic retries are live.
 */
export async function GET(request: Request) {
  const auth = authorizeWebhookCron(request);
  if (!auth.ok) {
    return NextResponse.json(auth.body, { status: auth.status });
  }

  try {
    const deliveries = await processDueWebhookDeliveries(defaultWebhookDeps());
    return NextResponse.json({
      ok: true,
      processed: deliveries.length,
      deliveries: deliveries.map(toPublicDelivery),
    });
  } catch {
    return NextResponse.json(
      { error: { code: "internal", message: "Webhook processor failed." } },
      { status: 500 },
    );
  }
}
