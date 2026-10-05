"use client";

import { ExportCsvButton } from "@/components/dashboard/ExportCsvButton";
import { useMerchantData } from "@/components/dashboard/MerchantData";
import { RequestRow } from "@/components/dashboard/presentation";
import {
  exportWorkspaceCsv,
  filterMerchantRequests,
  type RequestSort,
  type RequestStatusFilter,
} from "@/lib/merchantDashboard";
import Link from "next/link";
import { useMemo, useState } from "react";

const STATUS_TABS: { id: RequestStatusFilter; label: string }[] = [
  { id: "ALL", label: "All" },
  { id: "OPEN", label: "Open" },
  { id: "PAID", label: "Paid" },
  { id: "EXPIRED", label: "Expired" },
  { id: "CANCELLED", label: "Cancelled" },
];

export function RequestsPanel() {
  const { model, loading, error, refresh } = useMerchantData();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<RequestStatusFilter>("ALL");
  const [sort, setSort] = useState<RequestSort>("newest");
  const rows = useMemo(
    () => filterMerchantRequests(model.rows, { search, status, sort }),
    [model.rows, search, status, sort],
  );

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">Requests</p>
          <h1 className="display mt-2 text-4xl leading-none">Requests</h1>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <button type="button" className="text-sm underline" onClick={refresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <ExportCsvButton csv={exportWorkspaceCsv(model)} disabled={model.rows.length === 0} />
          <Link
            href="/dashboard/new"
            className="rounded-sm border border-[var(--ink)] bg-[var(--ink)] px-3 py-2 text-sm text-[var(--paper)] no-underline"
          >
            Create payment request
          </Link>
        </div>
      </div>
      {error ? <p className="mt-6 text-sm text-[var(--stamp)]">{error}</p> : null}
      {loading && model.rows.length === 0 && !error ? (
        <p className="mt-8 text-sm text-[var(--muted)]">Loading payment requests…</p>
      ) : null}
      {!error && !loading && model.rows.length === 0 ? (
        <p className="mt-8 text-sm text-[var(--muted)]">No payment requests for this wallet.</p>
      ) : null}
      {!error && model.rows.length > 0 ? (
        <>
          <div className="mt-6 flex flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1 text-sm">
              <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">Search</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Token, request id, memo, or transaction"
                className="mt-1 w-full border border-[var(--line)] bg-transparent px-3 py-2"
              />
            </label>
            <label className="text-sm">
              <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">Sort</span>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as RequestSort)}
                className="mt-1 block border border-[var(--line)] bg-transparent px-3 py-2"
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="amount-desc">Amount high to low</option>
                <option value="amount-asc">Amount low to high</option>
              </select>
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={status === tab.id ? "underline" : "text-[var(--muted)]"}
                onClick={() => setStatus(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {rows.length === 0 ? (
            <p className="mt-8 text-sm text-[var(--muted)]">No requests match this search.</p>
          ) : (
            <div className="mt-4">
              {rows.map((row) => (
                <RequestRow key={row.token} row={row} detailed />
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
