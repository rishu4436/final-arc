"use client";

import { ExportCsvButton } from "@/components/dashboard/ExportCsvButton";
import { useMerchantData } from "@/components/dashboard/MerchantData";
import { RequestRow } from "@/components/dashboard/presentation";
import { exportWorkspaceCsv, recentPayments, workspaceMetrics } from "@/lib/merchantDashboard";
import Link from "next/link";

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="bg-[var(--paper)] p-4">
      <dt className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">{label}</dt>
      <dd className="mono mt-2 text-2xl">{value}</dd>
      {note ? <p className="mt-2 text-xs text-[var(--muted)]">{note}</p> : null}
    </div>
  );
}

export function OverviewPanel() {
  const { model, loading, error, refresh } = useMerchantData();
  const recent = recentPayments(model);
  const metrics = workspaceMetrics(model);
  const showBody = !error && !(loading && model.rows.length === 0);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">Overview</p>
          <h1 className="display mt-2 text-4xl leading-none">Payments</h1>
        </div>
        <div className="flex items-center gap-4">
          <button type="button" className="text-sm underline" onClick={refresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <ExportCsvButton csv={exportWorkspaceCsv(model)} disabled={model.rows.length === 0} />
        </div>
      </div>

      {error ? <p className="mt-6 text-sm text-[var(--stamp)]">{error}</p> : null}

      {loading && model.rows.length === 0 && !error ? (
        <p className="mt-8 text-sm text-[var(--muted)]">Loading payment requests…</p>
      ) : null}

      {showBody ? (
        <>
          <dl className="mt-8 grid grid-cols-2 gap-px bg-[var(--line)] md:grid-cols-4">
            <Metric label="Total requests" value={String(metrics.total)} />
            <Metric label="Open" value={String(metrics.open)} />
            <Metric label="Paid" value={String(metrics.paid)} />
            <Metric label="Expired" value={String(metrics.expired)} />
            <Metric label="Cancelled" value={String(metrics.cancelled)} />
            <Metric label="Paid USDC" value={metrics.paidDisplay} note="Stored paid rows only." />
            <Metric label="Outstanding USDC" value={metrics.outstandingDisplay} note="Open requests only." />
          </dl>

          {!loading && metrics.total === 0 ? (
            <p className="mt-8 text-sm text-[var(--muted)]">No payment requests for this wallet.</p>
          ) : null}

          <div className="mt-12 flex items-end justify-between gap-3">
            <h2 className="display text-2xl">Recent payments</h2>
            <Link href="/dashboard/requests" className="text-sm text-[var(--muted)] no-underline">
              Requests
            </Link>
          </div>
          {recent.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--muted)]">No settled payments in the stored rows.</p>
          ) : (
            <div className="mt-2">
              {recent.map((row) => (
                <RequestRow key={row.token} row={row} />
              ))}
            </div>
          )}
          {model.skipped > 0 ? (
            <p className="mt-6 text-xs text-[var(--muted)]">Some stored rows could not be read and were left out.</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
