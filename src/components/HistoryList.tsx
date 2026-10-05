"use client";

import { CancelLinkButton } from "@/components/CancelLinkButton";
import { WALLET_ACTIONS } from "@/lib/apiScopes";
import { explorerTx, formatUsdc, shortHash } from "@/lib/format";
import { registerMissingLinks } from "@/lib/legacyLinkSync";
import { readLinks } from "@/lib/payLinksLocal";
import { cancelOffer, decodePayLink, paymentLinkPhase } from "@/lib/payRequest";
import type { PayRecord } from "@/lib/payStore";
import { cachedWalletHeaders, forgetWalletHeaders } from "@/lib/walletAuthCache";
import { useMounted } from "@/hooks/useMounted";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

function mergeRows(groups: PayRecord[][]): PayRecord[] {
  const map = new Map<string, PayRecord>();
  for (const group of groups) {
    for (const row of group) map.set(row.token, row);
  }
  return [...map.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function statusLabel(row: PayRecord, nowSeconds: number): { label: string; warn?: boolean } {
  const link = decodePayLink(row.token);
  if (link?.version === 2) {
    const phase = paymentLinkPhase({
      paid: Boolean(row.paidTx),
      cancelled: row.cancelled,
      expiresAt: link.request.expiresAt,
      nowSeconds,
    });
    return { label: phase, warn: phase === "CANCELLED" || phase === "EXPIRED" };
  }
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
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const { signMessageAsync } = useSignMessage();
  const signRef = useRef(signMessageAsync);
  signRef.current = signMessageAsync;

  const refresh = useCallback(async () => {
    if (!address) return;
    const sign = (args: { message: string }) => signRef.current(args);
    // Phase 13 (P1-05): the payee list requires the existing wallet authorization ("payments.read").
    const load = async () => {
      const headers = await cachedWalletHeaders(WALLET_ACTIONS.paymentsRead, address, sign);
      const res = await fetch(`/api/pay?to=${address}`, { headers, cache: "no-store" });
      if (res.status === 401) forgetWalletHeaders(WALLET_ACTIONS.paymentsRead, address);
      const body = (await res.json()) as { records?: PayRecord[]; error?: string };
      return { res, body };
    };
    let loaded: Awaited<ReturnType<typeof load>>;
    try {
      loaded = await load();
    } catch {
      setError("Sign the wallet authorization to load history.");
      return;
    }
    if (!loaded.res.ok) {
      setError(loaded.body.error ?? "Could not load history.");
      return;
    }
    const local = readLinks(address);
    const known = new Set((loaded.body.records ?? []).map((row) => row.token));
    if ((await registerMissingLinks(local.filter((token) => !known.has(token)), address, sign)) > 0) {
      try {
        const again = await load();
        if (again.res.ok) loaded = again;
      } catch {
        // Keep the first list.
      }
    }
    const body = loaded.body;
    const listed = new Set((body.records ?? []).map((row) => row.token));
    const remembered = (
      await Promise.all(
        local.filter((token) => !listed.has(token)).map(async (token) => {
          const item = await fetch(`/api/pay?token=${encodeURIComponent(token)}`);
          if (!item.ok) return null;
          const payload = (await item.json()) as { record?: PayRecord };
          return payload.record ?? null;
        }),
      )
    ).filter((row): row is PayRecord => row !== null);
    setError(null);
    setRows(mergeRows([body.records ?? [], remembered]));
    setNowSeconds(Math.floor(Date.now() / 1000));
  }, [address]);

  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);

  async function copy(token: string) {
    const url = `${window.location.origin}/p/${token}`;
    await navigator.clipboard.writeText(url);
  }

  if (!connected || !address) {
    return <p className="text-sm text-[var(--muted)]">Connect a wallet to see payment links.</p>;
  }

  if (rows.length === 0) {
    return <p className="text-sm text-[var(--muted)]">No payment links yet. Create one under Request.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-sm text-[var(--stamp)]">{error}</p> : null}
      {rows.map((row) => {
        const status = statusLabel(row, nowSeconds);
        const offer = cancelOffer({
          token: row.token,
          address,
          paid: Boolean(row.paidTx),
          cancelled: row.cancelled,
          nowSeconds,
        });
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
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
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
              {offer ? (
                <CancelLinkButton token={row.token} mode={offer} onDone={refresh} onError={setError} />
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
