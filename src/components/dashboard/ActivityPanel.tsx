"use client";

import { useMerchantData } from "@/components/dashboard/MerchantData";
import { formatStamp, requestDetailHref, StatusText } from "@/components/dashboard/presentation";
import { formatUsdc } from "@/lib/format";
import { buildActivity } from "@/lib/merchantDashboard";
import Link from "next/link";

export function ActivityPanel() {
  const { model, loading, error, refresh } = useMerchantData();
  const entries = buildActivity(model);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">Activity</p>
          <h1 className="display mt-2 text-4xl leading-none">Activity</h1>
          <p className="mt-3 max-w-xl text-sm text-[var(--muted)]">
            Taken from stored rows for this wallet. A created time is not a paid time. Cancellation and payment
            times are not stored.
          </p>
        </div>
        <button type="button" className="text-sm underline" onClick={refresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error ? <p className="mt-6 text-sm text-[var(--stamp)]">{error}</p> : null}
      {loading && model.rows.length === 0 && !error ? (
        <p className="mt-8 text-sm text-[var(--muted)]">Loading payment requests…</p>
      ) : null}
      {!error && !loading && entries.length === 0 ? (
        <p className="mt-8 text-sm text-[var(--muted)]">No activity for this wallet.</p>
      ) : null}
      {!error && entries.length > 0 ? (
        <div className="mt-8">
          {entries.map((entry) => {
            const when = entry.at ? formatStamp(entry.at) : null;
            return (
              <article key={entry.key} className="border-b border-[var(--line)] py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-sm">{entry.title}</h2>
                    <p className="mono mt-1">
                      {formatUsdc(entry.amount)} <span className="text-sm text-[var(--muted)]">USDC</span>
                    </p>
                    <p className="mt-1 break-words text-sm">{entry.memo}</p>
                  </div>
                  <StatusText status={entry.status} />
                </div>
                {when && entry.timeLabel ? (
                  <p className="mt-2 text-xs text-[var(--muted)]">
                    {entry.timeLabel} {when}
                  </p>
                ) : null}
                <p className="mt-2 text-xs text-[var(--muted)]">{entry.note}</p>
                {entry.detail ? <p className="mono mt-2 break-all text-xs">{entry.detail}</p> : null}
                <Link href={requestDetailHref(entry.token)} className="mt-3 inline-block text-sm underline">
                  Open request
                </Link>
              </article>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
