"use client";

import { CrossChainPay } from "@/components/CrossChainPay";
import { explorerAddress, explorerTx, formatUsdc, shortAddr } from "@/lib/format";
import type { PayRequest } from "@/lib/payRequest";
import type { PayRecord } from "@/lib/payStore";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export function PaySheet({ token, req }: { token: string; req: PayRequest }) {
  const [record, setRecord] = useState<PayRecord | null>(null);
  const viewed = useRef(false);

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

  const paid = Boolean(record?.paidTx);
  const cancelled = Boolean(record?.cancelled) && !paid;

  return (
    <article className="receipt-sheet">
      <div className="border-b border-[var(--line)] px-6 py-5 sm:px-8">
        <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">
          {paid ? "Paid" : cancelled ? "Cancelled" : "Payment on Arc"}
        </p>
        <p className="mono mt-3 text-4xl tracking-tight">
          {formatUsdc(req.amount)}
          <span className="ml-2 text-base text-[var(--muted)]">USDC</span>
        </p>
        <p className="mt-4 text-sm">
          To{" "}
          <a
            href={explorerAddress(req.to)}
            className="mono underline decoration-[var(--line)]"
            target="_blank"
            rel="noreferrer"
          >
            {shortAddr(req.to)}
          </a>
        </p>
        <p className="mt-1 text-sm text-[var(--muted)]">Memo · {req.memo}</p>
        {record ? (
          <p className="mt-3 text-xs text-[var(--muted)]">
            {record.views} {record.views === 1 ? "view" : "views"}
            {record.lastViewedAt ? ` · last ${new Date(record.lastViewedAt).toLocaleString()}` : ""}
          </p>
        ) : null}
      </div>
      <div className="p-6 sm:p-8">
        {paid && record?.paidTx ? (
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
        ) : cancelled ? (
          <p className="text-sm text-[var(--stamp)]">This payment link has been cancelled.</p>
        ) : (
          <CrossChainPay to={req.to} amount={req.amount} memo={req.memo} />
        )}
      </div>
    </article>
  );
}
