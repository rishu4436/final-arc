"use client";

import { CrossChainPay } from "@/components/CrossChainPay";
import { explorerAddress, explorerTx, formatUsdc, shortAddr } from "@/lib/format";
import { USDC_DECIMALS } from "@/lib/arc";
import { canOfferPay, decodePayLink, paymentLinkPhase, type PayLinkPhase } from "@/lib/payRequest";
import { verifyFinalRequest } from "@/lib/finalRequest";
import type { PayRecord } from "@/lib/payStore";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatUnits } from "viem";

const PHASE_LABEL: Record<PayLinkPhase, string> = {
  OPEN: "Open",
  PAID: "Paid",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

export function PaySheet({ token }: { token: string }) {
  const link = useMemo(() => decodePayLink(token), [token]);
  const [record, setRecord] = useState<PayRecord | null>(null);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const [signatureOk, setSignatureOk] = useState<boolean | null>(link?.version === 2 ? null : true);
  const viewed = useRef(false);

  useEffect(() => {
    if (!link || link.version !== 2) return;
    let stopped = false;
    void verifyFinalRequest(link.request).then((ok) => {
      if (!stopped) setSignatureOk(ok);
    });
    return () => {
      stopped = true;
    };
  }, [link]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    const key = `final-viewed:${token}`;
    const already = sessionStorage.getItem(key);
    const action = already ? "register" : "view";
    fetch("/api/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, action }),
    })
      .then((res) => res.json())
      .then((body: { record?: PayRecord }) => {
        if (body.record) setRecord(body.record);
        if (action === "view") sessionStorage.setItem(key, "1");
      })
      .catch(() => undefined);

    const poll = window.setInterval(() => {
      fetch(`/api/pay?token=${encodeURIComponent(token)}`)
        .then((res) => res.json())
        .then((body: { record?: PayRecord }) => {
          if (body.record) setRecord(body.record);
        })
        .catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(poll);
  }, [token]);

  if (!link || signatureOk === false) {
    return <p className="text-[var(--stamp)]">This payment link is not valid.</p>;
  }
  if (signatureOk === null) {
    return <p className="text-sm text-[var(--muted)]">Checking the payment request…</p>;
  }

  const expiresAt = link.version === 2 ? link.request.expiresAt : null;
  const phase = paymentLinkPhase({
    paid: Boolean(record?.paidTx),
    cancelled: Boolean(record?.cancelled),
    expiresAt,
    nowSeconds,
  });
  const amount =
    link.version === 2
      ? formatUsdc(formatUnits(link.request.amountBaseUnits, USDC_DECIMALS))
      : formatUsdc(link.request.amount);
  const recipient = link.version === 2 ? link.request.recipient : link.request.to;
  const memo = link.request.memo;

  return (
    <article className="receipt-sheet">
      <div className="border-b border-[var(--line)] px-6 py-5 sm:px-8">
        <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">
          {link.version === 2 ? `V2 · ${PHASE_LABEL[phase]} · Arc USDC` : PHASE_LABEL[phase]}
        </p>
        <p className="mono mt-3 text-4xl tracking-tight">
          {amount}
          <span className="ml-2 text-base text-[var(--muted)]">USDC</span>
        </p>
        {link.version === 2 ? (
          <p className="mt-4 text-sm">
            Merchant{" "}
            <a
              href={explorerAddress(link.request.merchant)}
              className="mono underline decoration-[var(--line)]"
              target="_blank"
              rel="noreferrer"
            >
              {shortAddr(link.request.merchant)}
            </a>
          </p>
        ) : null}
        <p className={`${link.version === 2 ? "mt-1" : "mt-4"} text-sm`}>
          To{" "}
          <a
            href={explorerAddress(recipient)}
            className="mono underline decoration-[var(--line)]"
            target="_blank"
            rel="noreferrer"
          >
            {shortAddr(recipient)}
          </a>
        </p>
        <p className="mt-1 text-sm text-[var(--muted)]">Memo · {memo}</p>
        {link.version === 2 ? (
          <p className="mt-1 text-sm text-[var(--muted)]">
            Arc · chain 5042 · expires {new Date(link.request.expiresAt * 1000).toLocaleString()}
          </p>
        ) : (
          <p className="mt-1 text-sm text-[var(--muted)]">Arc USDC</p>
        )}
        {record ? (
          <p className="mt-3 text-xs text-[var(--muted)]">
            {record.views} {record.views === 1 ? "view" : "views"}
            {record.lastViewedAt ? ` · last ${new Date(record.lastViewedAt).toLocaleString()}` : ""}
          </p>
        ) : null}
      </div>
      <div className="p-6 sm:p-8">
        {phase === "PAID" && record?.paidTx ? (
          <p className="text-sm">
            Settled.{" "}
            <Link href={`/r/${record.paidTx}`} className="underline">
              Open receipt
            </Link>
            {" · "}
            <a href={explorerTx(record.paidTx)} className="underline" target="_blank" rel="noreferrer">
              Explorer
            </a>
          </p>
        ) : phase === "CANCELLED" ? (
          <p className="text-sm text-[var(--stamp)]">This payment request has been cancelled.</p>
        ) : phase === "EXPIRED" ? (
          <p className="text-sm text-[var(--stamp)]">This Arc USDC payment request has expired.</p>
        ) : canOfferPay(phase) ? (
          link.version === 2 ? (
            <CrossChainPay version={2} request={link.request} />
          ) : (
            <CrossChainPay version={1} to={link.request.to} amount={link.request.amount} memo={link.request.memo} />
          )
        ) : null}
      </div>
    </article>
  );
}
