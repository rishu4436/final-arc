"use client";

import { explorerTx, formatUsdc, shortAddr, shortHash } from "@/lib/format";
import type { LedgerEntry } from "@/lib/ledger";
import { readLinks } from "@/lib/payLinksLocal";
import type { PayRecord } from "@/lib/payStore";
import { useMounted } from "@/hooks/useMounted";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";

function linkStatus(row: PayRecord): { label: string; warn?: boolean } {
  if (row.paidTx) return { label: "Paid" };
  if (row.cancelled) return { label: "Cancelled", warn: true };
  if (row.views > 0) return { label: `Viewed · ${row.views}` };
  return { label: "Unseen" };
}

export function Statement() {
  const mounted = useMounted();
  const { address, isConnected } = useAccount();
  const connected = mounted && isConnected && Boolean(address);
  const [payments, setPayments] = useState<LedgerEntry[]>([]);
  const [links, setLinks] = useState<PayRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
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
      const res = await fetch(`/api/statement?address=${address}`);
      const body = (await res.json()) as {
        payments?: LedgerEntry[];
        links?: PayRecord[];
        error?: string;
      };
      if (!res.ok) {
        setError(body.error ?? "Could not load statement.");
        return;
      }
      setError(null);
      setPayments(body.payments ?? []);
      setLinks(body.links ?? []);
    } finally {
      setLoading(false);
    }
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
    await navigator.clipboard.writeText(`${window.location.origin}/p/${token}`);
  }

  if (!connected) {
    return <p className="text-sm text-[var(--muted)]">Connect a wallet to read its Memo ledger on Arc.</p>;
  }

  const openLinks = links.filter((row) => !row.paidTx);

  return (
    <div className="flex flex-col gap-8">
      {error ? <p className="text-sm text-[var(--stamp)]">{error}</p> : null}

      <section>
        <h3 className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Open links</h3>
        {openLinks.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--muted)]">None.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-4">
            {openLinks.map((row) => {
              const status = linkStatus(row);
              return (
                <div key={row.token} className="border-b border-[var(--line)] pb-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="mono text-lg">
                        {formatUsdc(row.amount)}{" "}
                        <span className="text-sm text-[var(--muted)]">USDC</span>
                      </p>
                      <p className="text-sm text-[var(--muted)]">{row.memo}</p>
                    </div>
                    <p
                      className={`text-xs uppercase tracking-[0.14em] ${status.warn ? "text-[var(--stamp)]" : ""}`}
                    >
                      {status.label}
                    </p>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3 text-sm">
                    <button type="button" className="underline" onClick={() => copy(row.token)}>
                      Copy link
                    </button>
                    {!row.cancelled ? (
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
          </div>
        )}
      </section>

      <section>
        <h3 className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
          Memo payments
        </h3>
        {loading && payments.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--muted)]">Reading Arc…</p>
        ) : payments.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--muted)]">No Memo transfers in the recent window.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-4">
            {payments.map((row) => (
              <div key={row.txHash} className="border-b border-[var(--line)] pb-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="mono text-lg">
                      {row.direction === "in" ? "+" : "−"}
                      {formatUsdc(row.amount)}{" "}
                      <span className="text-sm text-[var(--muted)]">USDC</span>
                    </p>
                    <p className="text-sm text-[var(--muted)]">{row.memo ?? "—"}</p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {row.direction === "in" ? "from" : "to"} {shortAddr(row.direction === "in" ? row.from : row.to)}
                      {" · block "}
                      {row.blockNumber}
                    </p>
                  </div>
                  <p className="text-xs uppercase tracking-[0.14em] text-[var(--ok)]">
                    {row.direction === "in" ? "In" : "Out"}
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap gap-3 text-sm">
                  <Link href={`/r/${row.txHash}`} className="underline">
                    Receipt
                  </Link>
                  <a href={explorerTx(row.txHash)} className="underline" target="_blank" rel="noreferrer">
                    {shortHash(row.txHash)}
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <button type="button" className="self-start text-sm underline" onClick={() => void refresh()}>
        Refresh
      </button>
    </div>
  );
}
