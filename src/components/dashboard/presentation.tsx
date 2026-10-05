import type { DashboardRequestRow, DashboardStatus } from "@/lib/merchantDashboard";
import { explorerTx, formatUsdc, shortAddr, shortHash } from "@/lib/format";
import Link from "next/link";

export function formatStamp(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

export function formatExpiry(seconds: number | null): string | null {
  if (seconds == null) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

export function StatusText({ status }: { status: DashboardStatus }) {
  const color =
    status === "PAID"
      ? "text-[var(--ok)]"
      : status === "CANCELLED" || status === "EXPIRED"
        ? "text-[var(--stamp)]"
        : "text-[var(--ink)]";
  return <span className={`text-xs uppercase tracking-[0.14em] ${color}`}>{status}</span>;
}

export function requestDetailHref(token: string): string {
  return `/dashboard/requests/${encodeURIComponent(token)}`;
}

export function RequestRow({ row, detailed }: { row: DashboardRequestRow; detailed?: boolean }) {
  const created = formatStamp(row.createdAt);
  const expiry = formatExpiry(row.expiresAt);
  return (
    <article className="border-b border-[var(--line)] py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mono text-lg">
            {formatUsdc(row.amount)} <span className="text-sm text-[var(--muted)]">USDC</span>
          </p>
          <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
            {row.version === 2 ? "V2" : "V1"}
          </p>
          <p className="mt-1 break-words text-sm">{row.memo}</p>
        </div>
        <StatusText status={row.status} />
      </div>
      <dl className="mt-3 grid gap-2 text-xs text-[var(--muted)] sm:grid-cols-2">
        {created ? (
          <div>
            <dt className="uppercase tracking-[0.14em]">Created</dt>
            <dd className="mt-1 text-[var(--ink)]">{created}</dd>
          </div>
        ) : null}
        {detailed && row.requestId ? (
          <div className="min-w-0">
            <dt className="uppercase tracking-[0.14em]">Request ID</dt>
            <dd className="mono mt-1 break-all text-[var(--ink)]">{row.requestId}</dd>
          </div>
        ) : null}
        {detailed && row.v1LinkId ? (
          <div className="min-w-0">
            <dt className="uppercase tracking-[0.14em]">Link id</dt>
            <dd className="mono mt-1 break-all text-[var(--ink)]">{row.v1LinkId}</dd>
          </div>
        ) : null}
        {detailed && row.memoId ? (
          <div className="min-w-0">
            <dt className="uppercase tracking-[0.14em]">Memo ID</dt>
            <dd className="mono mt-1 break-all text-[var(--ink)]">{row.memoId}</dd>
          </div>
        ) : null}
        {detailed && expiry ? (
          <div>
            <dt className="uppercase tracking-[0.14em]">Expires</dt>
            <dd className="mt-1 text-[var(--ink)]">{expiry}</dd>
          </div>
        ) : null}
        {detailed ? (
          <div className="min-w-0">
            <dt className="uppercase tracking-[0.14em]">Recipient</dt>
            <dd className="mono mt-1 break-all text-[var(--ink)]">{shortAddr(row.recipient)}</dd>
          </div>
        ) : null}
      </dl>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <Link href={requestDetailHref(row.token)} className="underline">
          Open
        </Link>
        {row.receiptPath ? (
          <Link href={row.receiptPath} className="underline">
            Receipt
          </Link>
        ) : null}
        {row.paidTx ? (
          <a href={explorerTx(row.paidTx)} className="mono underline" target="_blank" rel="noreferrer">
            {shortHash(row.paidTx)}
          </a>
        ) : null}
      </div>
    </article>
  );
}
