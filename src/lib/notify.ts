import type { PayRecord } from "./payStore";

export type PayEvent = "viewed" | "paid" | "cancelled";

export async function notifyWebhook(record: PayRecord, event: PayEvent): Promise<void> {
  const url = record.webhookUrl;
  if (!url || !/^https:\/\//i.test(url)) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event,
        token: record.token,
        to: record.to,
        amount: record.amount,
        memo: record.memo,
        views: record.views,
        paidTx: record.paidTx,
        cancelled: record.cancelled,
      }),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    /* webhook delivery is best-effort */
  }
}
