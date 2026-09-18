"use client";

import { explorerTx, formatUsdc, shortHash } from "@/lib/format";
import { readLinks } from "@/lib/payLinksLocal";
import type { PayRecord } from "@/lib/payStore";
import { useMounted } from "@/hooks/useMounted";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";

function statusLabel(row: PayRecord): { label: string; warn?: boolean } {
  if (row.paidTx) return { label: "Paid" };
  if (row.cancelled) return { label: "Cancelled", warn: true };
  if (row.views > 0) return { label: `Viewed · ${row.views}` };
  return { label: "Unseen" };
}

export function HistoryList() {
  const mounted = useMounted();
  const { address, isConnected } = useAccount();
  const connected = mounted && isConnected && Boolean(address);
  const [rows, setRows] = useState<PayRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    const local = readLinks(address);
    await Promise.all(
      local.map((token) =>
        fetch("/api/pay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, action: "register" }),
        }).catch(() => undefined),
      ),
    );
    const res = await fetch(`/api/pay?to=${address}`);
    const body = (await res.json()) as { records?: PayRecord[]; error?: string };
    if (!res.ok) {
      setError(body.error ?? "Could not load history.");
      return;
    }
    setError(null);
    setRows(body.records ?? []);
  }, [address]);

  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);

  async function cancel(token: string) {
    if (!address) return;
    setBusy(token);
    try {
      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, action: "cancel", address }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? "Cancel failed.");
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function copy(token: string) {
    const url = `${window.location.origin}/p/${token}`;
    await navigator.clipboard.writeText(url);
  }

  if (!connected) {
    return <p className="text-sm text-[var(--muted)]">Connect the payee wallet to see payment links.</p>;
  }

  if (rows.length === 0) {
    return <p className="text-sm text-[var(--muted)]">No payment links yet. Create one under Request.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-sm text-[var(--stamp)]">{error}</p> : null}
      {rows.map((row) => {
        const status = statusLabel(row);
        return (
          <div key={row.token} className="border-b border-[var(--line)] pb-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="mono text-lg">
                  {formatUsdc(row.amount)} <span className="text-sm text-[var(--muted)]">USDC</span>
                </p>
                <p className="text-sm text-[var(--muted)]">{row.memo}</p>
              </div>
              <p className={`text-xs uppercase tracking-[0.14em] ${status.warn ? "text-[var(--stamp)]" : "text-[var(--ok)]"}`}>
                {status.label}
              </p>
            </div>
            <p className="mt-2 text-xs text-[var(--muted)]">
              {new Date(row.createdAt).toLocaleString()}
              {row.lastViewedAt ? ` · viewed ${new Date(row.lastViewedAt).toLocaleString()}` : ""}
            </p>
            <div className="mt-3 flex flex-wrap gap-3 text-sm">
              <button type="button" className="underline" onClick={() => copy(row.token)}>
                Copy link
              </button>
              {row.paidTx ? (
                <>
                  <Link href={`/r/${row.paidTx}`} className="underline">
                    Receipt
                  </Link>
                  <a href={explorerTx(row.paidTx)} className="underline" target="_blank" rel="noreferrer">
                    {shortHash(row.paidTx)}
                  </a>
                </>
              ) : null}
              {!row.paidTx && !row.cancelled ? (
                <button
                  type="button"
                  className="underline text-[var(--stamp)]"
                  disabled={busy === row.token}
                  onClick={() => cancel(row.token)}
                >
                  {busy === row.token ? "Cancelling…" : "Cancel"}
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
      <button type="button" className="self-start text-sm underline" onClick={() => void refresh()}>
        Refresh
      </button>
    </div>
  );
}
