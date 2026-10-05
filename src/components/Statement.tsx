"use client";

import { CancelLinkButton } from "@/components/CancelLinkButton";
import { WALLET_ACTIONS } from "@/lib/apiScopes";
import { explorerTx, formatUsdc, shortAddr, shortHash } from "@/lib/format";
import type { LedgerEntry } from "@/lib/ledger";
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

async function recordsForTokens(tokens: string[]): Promise<PayRecord[]> {
  const rows = await Promise.all(
    tokens.map(async (token) => {
      const res = await fetch(`/api/pay?token=${encodeURIComponent(token)}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { record?: PayRecord };
      return body.record ?? null;
    }),
  );
  return rows.filter((row): row is PayRecord => row !== null);
}

function linkStatus(row: PayRecord, nowSeconds: number): { label: string; warn?: boolean } {
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

export function Statement() {
  const mounted = useMounted();
  const { address, isConnected } = useAccount();
  const connected = mounted && isConnected && Boolean(address);
  const [payments, setPayments] = useState<LedgerEntry[]>([]);
  const [links, setLinks] = useState<PayRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const { signMessageAsync } = useSignMessage();
  const signRef = useRef(signMessageAsync);
  signRef.current = signMessageAsync;

  const refresh = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const sign = (args: { message: string }) => signRef.current(args);
      // Phase 13 (P1-05): the statement is merchant-private. It requires the existing
      // wallet authorization for this address ("payments.read").
      const load = async () => {
        const headers = await cachedWalletHeaders(WALLET_ACTIONS.paymentsRead, address, sign);
        const res = await fetch(`/api/statement?address=${address}`, { headers, cache: "no-store" });
        if (res.status === 401) forgetWalletHeaders(WALLET_ACTIONS.paymentsRead, address);
        const body = (await res.json()) as {
          payments?: LedgerEntry[];
          links?: PayRecord[];
          error?: string;
        };
        return { res, body };
      };
      let loaded: Awaited<ReturnType<typeof load>>;
      try {
        loaded = await load();
      } catch {
        setError("Sign the wallet authorization to load the statement.");
        return;
      }
      if (!loaded.res.ok) {
        setError(loaded.body.error ?? "Could not load statement.");
        return;
      }
      const local = readLinks(address);
      const known = new Set((loaded.body.links ?? []).map((row) => row.token));
      const missing = local.filter((token) => !known.has(token));
      const registered = await registerMissingLinks(missing, address, sign);
      if (registered > 0) {
        try {
          const again = await load();
          if (again.res.ok) loaded = again;
        } catch {
          // Keep the first statement.
        }
      }
      const listed = new Set((loaded.body.links ?? []).map((row) => row.token));
      const remembered = await recordsForTokens(local.filter((token) => !listed.has(token)));
      setError(null);
      setPayments(loaded.body.payments ?? []);
      setLinks(mergeRows([loaded.body.links ?? [], remembered]));
      setNowSeconds(Math.floor(Date.now() / 1000));
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);

  async function copy(token: string) {
    await navigator.clipboard.writeText(`${window.location.origin}/p/${token}`);
  }

  if (!connected || !address) {
    return <p className="text-sm text-[var(--muted)]">Connect a wallet to read its Memo ledger on Arc.</p>;
  }

  const openLinks = links.filter((row) => !row.paidTx);

  return (
    <div className="flex flex-col gap-8">
      {error ? <p className="text-sm text-[var(--stamp)]">{error}</p> : null}

      <section>
        <h3 className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Payment links</h3>
        {openLinks.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--muted)]">None.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-4">
            {openLinks.map((row) => {
              const status = linkStatus(row, nowSeconds);
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
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                    <button type="button" className="underline" onClick={() => copy(row.token)}>
                      Copy link
                    </button>
                    {offer ? (
                      <CancelLinkButton
                        token={row.token}
                        mode={offer}
                        onDone={refresh}
                        onError={setError}
                      />
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
